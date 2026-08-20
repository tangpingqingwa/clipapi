import type { CreatorVideo, CreatorVideoPage, Cue, Transcript } from "../../types.js";
import type { AdapterFailureCode } from "../types.js";

export type ParsedVideoPageOk = {
  ok: true;
  videoId: string;
  canonicalUrl: string;
  kind: Transcript["kind"];
  language: string;
  durationMs: number | null;
  author: Transcript["author"];
  metadata: Transcript["metadata"];
  source: Transcript["source"];
  cues: Cue[];
  subtitleUrl: string | null;
};

export type ParsedVideoPage = ParsedVideoPageOk | { ok: false; code: AdapterFailureCode };

const UNIVERSAL_SCRIPT_RE =
  /<script[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i;
const SIGI_SCRIPT_RE =
  /<script[^>]*\bid=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i;

const BLOCKED_RE =
  /captcha-verify|id=["']captcha["']|cdn-cgi\/challenge|access denied/i;
const DELETED_RE =
  /video currently unavailable|couldn['’]t find this video|video is unavailable|this video is private/i;

const NOT_FOUND_STATUS = new Set([10204, 10215, 10216, 10217]);
const CREATOR_NOT_FOUND_STATUS = new Set([10202, 10204, 10215, 10216, 10217, 10221]);

export type ParsedCreatorPage =
  | { ok: true; page: CreatorVideoPage }
  | { ok: false; code: AdapterFailureCode };

export function parseTikTokVideoPage(
  html: string,
  videoId: string,
  lang?: string,
): ParsedVideoPage {
  if (BLOCKED_RE.test(html)) {
    return { ok: false, code: "upstream_blocked" };
  }

  const universal = parseJsonObject(firstGroup(UNIVERSAL_SCRIPT_RE, html));
  if (universal !== null) {
    const parsed = parseUniversalData(universal, videoId, lang);
    if (parsed !== null) {
      return parsed;
    }
  }

  const sigi = parseJsonObject(firstGroup(SIGI_SCRIPT_RE, html));
  if (sigi !== null) {
    const parsed = parseSigiState(sigi, videoId, lang);
    if (parsed !== null) {
      return parsed;
    }
  }

  if (DELETED_RE.test(html)) {
    return { ok: false, code: "not_found" };
  }
  return { ok: false, code: "upstream_blocked" };
}

/**
 * Public creator profile HTML → video page. Empty `itemList` is a real empty
 * page, not invented uploads. Unknown / banned handles are `not_found`.
 */
export function parseTikTokCreatorPage(
  html: string,
  handle: string,
  cursor?: string,
  limit = 15,
): ParsedCreatorPage {
  if (BLOCKED_RE.test(html)) {
    return { ok: false, code: "upstream_blocked" };
  }

  const universal = parseJsonObject(firstGroup(UNIVERSAL_SCRIPT_RE, html));
  if (universal !== null) {
    const parsed = parseUniversalCreator(universal, handle, cursor, limit);
    if (parsed !== null) {
      return parsed;
    }
  }

  const sigi = parseJsonObject(firstGroup(SIGI_SCRIPT_RE, html));
  if (sigi !== null) {
    const parsed = parseSigiCreator(sigi, handle, cursor, limit);
    if (parsed !== null) {
      return parsed;
    }
  }

  return { ok: false, code: "upstream_blocked" };
}

export function parseSubtitleBody(body: string): Cue[] {
  const trimmed = body.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") {
    return [];
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return parseSubtitleJson(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  return parseWebVtt(trimmed);
}

export function isAllowedSubtitleUrl(url: URL): boolean {
  if (url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    host === "www.tiktok.com" ||
    host.endsWith(".tiktok.com") ||
    host.endsWith(".tiktokcdn.com") ||
    host.endsWith(".tiktokv.com") ||
    host.endsWith(".ibyteimg.com")
  );
}

function parseUniversalData(
  data: Record<string, unknown>,
  videoId: string,
  lang?: string,
): ParsedVideoPage | null {
  const scope = asRecord(data["__DEFAULT_SCOPE__"]);
  if (scope === null) {
    return null;
  }
  const detail = asRecord(scope["webapp.video-detail"]);
  if (detail === null) {
    return null;
  }
  const statusCode = detail.statusCode;
  if (typeof statusCode === "number" && NOT_FOUND_STATUS.has(statusCode)) {
    return { ok: false, code: "not_found" };
  }
  const itemInfo = asRecord(detail.itemInfo);
  if (itemInfo === null) {
    return typeof statusCode === "number" && statusCode !== 0
      ? { ok: false, code: "not_found" }
      : null;
  }
  const item = asRecord(itemInfo.itemStruct);
  if (item === null) {
    return { ok: false, code: "not_found" };
  }
  return itemToPage(item, videoId, lang);
}

function parseUniversalCreator(
  data: Record<string, unknown>,
  requestedHandle: string,
  cursor: string | undefined,
  limit: number,
): ParsedCreatorPage | null {
  const scope = asRecord(data["__DEFAULT_SCOPE__"]);
  if (scope === null) {
    return null;
  }
  const detail = asRecord(scope["webapp.user-detail"]);
  if (detail === null) {
    return null;
  }
  const statusCode = detail.statusCode;
  if (typeof statusCode === "number" && CREATOR_NOT_FOUND_STATUS.has(statusCode)) {
    return { ok: false, code: "not_found" };
  }
  const userInfo = asRecord(detail.userInfo);
  if (userInfo === null) {
    return typeof statusCode === "number" && statusCode !== 0
      ? { ok: false, code: "not_found" }
      : null;
  }
  const user = asRecord(userInfo.user);
  if (user === null) {
    return { ok: false, code: "not_found" };
  }
  const handle =
    readString(user, "uniqueId", "unique_id", "handle") ?? requestedHandle;
  const authorId = readString(user, "id") ?? null;
  const items = collectCreatorItems(userInfo.itemList ?? userInfo.items);
  return paginateCreatorItems(handle, authorId, items, cursor, limit);
}

function parseSigiCreator(
  data: Record<string, unknown>,
  requestedHandle: string,
  cursor: string | undefined,
  limit: number,
): ParsedCreatorPage | null {
  const userModule = asRecord(data.UserModule);
  const users = userModule === null ? null : asRecord(userModule.users) ?? userModule;
  let handle = requestedHandle;
  let authorId: string | null = null;
  if (users !== null) {
    const direct = asRecord(users[requestedHandle]);
    const firstKey = Object.keys(users)[0];
    const first = firstKey === undefined ? null : asRecord(users[firstKey]);
    const chosen = direct ?? first;
    if (chosen !== null) {
      handle = readString(chosen, "uniqueId", "unique_id", "handle") ?? handle;
      authorId = readString(chosen, "id") ?? null;
    }
  }
  const itemModule = asRecord(data.ItemModule);
  if (itemModule === null) {
    return null;
  }
  const items = Object.values(itemModule).flatMap((raw) => {
    const rec = asRecord(raw);
    return rec === null ? [] : [creatorVideoFromItem(rec, handle, authorId)];
  });
  return paginateCreatorItems(handle, authorId, items, cursor, limit);
}

function collectCreatorItems(raw: unknown): CreatorVideo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CreatorVideo[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec === null) {
      continue;
    }
    out.push(creatorVideoFromItem(rec, null, null));
  }
  return out;
}

function creatorVideoFromItem(
  item: Record<string, unknown>,
  fallbackHandle: string | null,
  fallbackAuthorId: string | null,
): CreatorVideo {
  const videoId = readString(item, "id", "videoId") ?? "";
  const description = readString(item, "desc", "description", "title") ?? null;
  const author = readAuthor(item);
  const handle = author.handle ?? fallbackHandle;
  const video = asRecord(item.video);
  const durationMs = readDurationMs(video);
  const captions = hasCaptionTracks(video);
  return {
    videoId,
    title: description,
    description,
    author: {
      handle,
      id: author.id ?? fallbackAuthorId,
    },
    lengthText: formatLengthText(durationMs),
    hasCaptions: captions,
    url:
      videoId === ""
        ? `https://www.tiktok.com/@${handle ?? "_"}`
        : `https://www.tiktok.com/@${handle ?? "_"}/video/${videoId}`,
    createTime: readCreateTime(item.createTime),
  };
}

function hasCaptionTracks(video: Record<string, unknown> | null): boolean | null {
  if (video === null) {
    return null;
  }
  const refs = readSubtitleRefs(video);
  if (refs.length > 0) {
    return true;
  }
  const cla = asRecord(video.claInfo);
  if (cla !== null && Array.isArray(cla.captionInfos)) {
    return cla.captionInfos.length > 0;
  }
  return null;
}

function formatLengthText(durationMs: number | null): string | null {
  if (durationMs === null || durationMs < 0) {
    return null;
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function paginateCreatorItems(
  handle: string,
  _authorId: string | null,
  items: CreatorVideo[],
  cursor: string | undefined,
  limit: number,
): ParsedCreatorPage {
  const videos = items.filter((item) => item.videoId !== "");
  const start = parseOffsetCursor(cursor);
  if (start === null) {
    return { ok: false, code: "not_found" };
  }
  const pageSize = Number.isInteger(limit) && limit > 0 ? limit : 15;
  const slice = videos.slice(start, start + pageSize);
  const nextOffset = start + pageSize;
  return {
    ok: true,
    page: {
      handle,
      platform: "tiktok",
      videos: slice,
      nextCursor: nextOffset < videos.length ? String(nextOffset) : null,
    },
  };
}

function parseOffsetCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === "") {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    return null;
  }
  return Number(cursor);
}

function parseSigiState(
  data: Record<string, unknown>,
  videoId: string,
  lang?: string,
): ParsedVideoPage | null {
  const items = asRecord(data.ItemModule);
  if (items === null) {
    return null;
  }
  const direct = asRecord(items[videoId]);
  if (direct !== null) {
    return itemToPage(direct, videoId, lang, asRecord(data.UserModule));
  }
  const firstKey = Object.keys(items)[0];
  if (firstKey === undefined) {
    return { ok: false, code: "not_found" };
  }
  const first = asRecord(items[firstKey]);
  if (first === null) {
    return { ok: false, code: "not_found" };
  }
  return itemToPage(first, videoId, lang, asRecord(data.UserModule));
}

function itemToPage(
  item: Record<string, unknown>,
  requestedId: string,
  lang?: string,
  userModule?: Record<string, unknown> | null,
): ParsedVideoPage {
  const id = readString(item, "id") ?? requestedId;
  const description = readString(item, "desc", "description");
  const createTime = readCreateTime(item.createTime);
  const video = asRecord(item.video);
  const durationMs = readDurationMs(video);
  const kind = item.imagePost !== undefined && item.imagePost !== null ? "slideshow" : "video";
  const author = readAuthor(item, userModule);
  const music = asRecord(item.music);
  const musicTitle = music === null ? null : readString(music, "title", "musicName");
  const subtitles = readSubtitleRefs(video);
  const chosen = pickSubtitle(subtitles, lang);

  if (subtitles.length === 0) {
    return { ok: false, code: "no_transcript" };
  }
  if (chosen === undefined || chosen.url === "") {
    return { ok: false, code: "no_transcript" };
  }

  return {
    ok: true,
    videoId: id,
    canonicalUrl: `https://www.tiktok.com/@${author.handle ?? "_"}/video/${id}`,
    kind,
    language: chosen.language,
    durationMs,
    author,
    metadata: {
      description: description ?? null,
      createTime,
      musicTitle: musicTitle ?? null,
    },
    source: chosen.source,
    cues: [],
    subtitleUrl: chosen.url,
  };
}

type SubtitleRef = {
  url: string;
  language: string;
  source: Transcript["source"];
};

function readSubtitleRefs(video: Record<string, unknown> | null): SubtitleRef[] {
  if (video === null) {
    return [];
  }
  const out: SubtitleRef[] = [];
  collectSubtitleEntries(video.subtitleInfos ?? video.SubtitleInfos, out);
  const cla = asRecord(video.claInfo);
  if (cla !== null) {
    collectSubtitleEntries(cla.captionInfos ?? cla.CaptionInfos, out);
  }
  return out;
}

function collectSubtitleEntries(raw: unknown, out: SubtitleRef[]): void {
  if (!Array.isArray(raw)) {
    return;
  }
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec === null) {
      continue;
    }
    const url = readString(rec, "url", "Url") ?? firstStringInList(rec.urlList);
    if (url === undefined || url === "") {
      continue;
    }
    const languageCode =
      readString(rec, "languageCodeName", "LanguageCodeName", "language", "Language") ?? "und";
    const sourceRaw = readString(rec, "source", "Source") ?? "";
    const auto =
      rec.isAutoGen === true || rec.IsAutoGen === true || /asr/i.test(sourceRaw);
    out.push({
      url,
      language: toBcp47(languageCode),
      source: auto ? "platform_asr" : "platform_caption",
    });
  }
}

function firstStringInList(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const first = value.find((item) => typeof item === "string" && item !== "");
  return typeof first === "string" ? first : undefined;
}

function pickSubtitle(infos: SubtitleRef[], lang?: string): SubtitleRef | undefined {
  if (lang !== undefined && lang !== "" && lang !== "*") {
    const wanted = lang.toLowerCase();
    const match = infos.find(
      (info) =>
        info.language.toLowerCase() === wanted ||
        info.language.toLowerCase().startsWith(`${wanted}-`) ||
        wanted.startsWith(info.language.toLowerCase()),
    );
    if (match !== undefined) {
      return match;
    }
  }
  return infos.find((info) => info.source === "platform_caption") ?? infos[0];
}

function readAuthor(
  item: Record<string, unknown>,
  userModule?: Record<string, unknown> | null,
): Transcript["author"] {
  const author = item.author;
  if (typeof author === "string") {
    const fromUsers = userFromModule(userModule, author);
    return {
      handle: author,
      id: fromUsers?.id ?? readString(item, "authorId") ?? null,
    };
  }
  const rec = asRecord(author);
  if (rec !== null) {
    return {
      handle: readString(rec, "uniqueId", "unique_id", "handle") ?? null,
      id: readString(rec, "id") ?? null,
    };
  }
  return { handle: null, id: readString(item, "authorId") ?? null };
}

function userFromModule(
  userModule: Record<string, unknown> | null | undefined,
  handle: string,
): { id: string | null } | null {
  if (userModule === null || userModule === undefined) {
    return null;
  }
  const users = asRecord(userModule.users) ?? asRecord(userModule);
  if (users === null) {
    return null;
  }
  const row = asRecord(users[handle]);
  if (row === null) {
    return null;
  }
  return { id: readString(row, "id") ?? null };
}

function readDurationMs(video: Record<string, unknown> | null): number | null {
  if (video === null) {
    return null;
  }
  const duration = video.duration;
  if (typeof duration === "number" && Number.isFinite(duration)) {
    return Math.round(duration * 1000);
  }
  return null;
}

function readCreateTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return new Date(Number(value) * 1000).toISOString();
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return null;
}

function parseSubtitleJson(value: unknown): Cue[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => jsonCue(entry));
  }
  const rec = asRecord(value);
  if (rec === null) {
    return [];
  }
  const list = rec.content ?? rec.cues ?? rec.utterances ?? rec.transcript;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((entry) => jsonCue(entry));
}

function jsonCue(value: unknown): Cue[] {
  const rec = asRecord(value);
  if (rec === null) {
    return [];
  }
  const text = readString(rec, "text", "caption", "content");
  if (text === undefined || text.trim() === "") {
    return [];
  }
  const start = readSeconds(rec, "start", "startTime", "start_time", "startMs", "start_ms");
  if (start === null) {
    return [];
  }
  const end = readSeconds(rec, "end", "endTime", "end_time", "endMs", "end_ms");
  const durationRaw = readSeconds(rec, "duration", "durationMs", "duration_ms");
  let duration: number | null = null;
  if (durationRaw !== null) {
    duration = durationRaw;
  } else if (end !== null) {
    duration = roundSeconds(end - start);
  }
  return [{ text: text.trim(), start, duration }];
}

function readSeconds(rec: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    // TikTok JSON caption `startTime`/`endTime` (and *Ms) are milliseconds.
    if (/ms$/i.test(key) || key === "startTime" || key === "endTime") {
      return roundSeconds(value / 1000);
    }
    return roundSeconds(value);
  }
  return null;
}

function parseWebVtt(body: string): Cue[] {
  const blocks = body.replace(/\r\n/g, "\n").split(/\n\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex === -1) {
      continue;
    }
    const timing = parseVttRange(lines[timeIndex] ?? "");
    if (timing === null) {
      continue;
    }
    const text = lines
      .slice(timeIndex + 1)
      .map((line) => line.replace(/<[^>]+>/g, "").trim())
      .filter((line) => line !== "")
      .join(" ");
    if (text === "") {
      continue;
    }
    cues.push({
      text,
      start: timing.start,
      duration: roundSeconds(timing.end - timing.start),
    });
  }
  return cues;
}

function parseVttRange(line: string): { start: number; end: number } | null {
  const match = /([\d:.]+)\s+-->\s+([\d:.]+)/.exec(line);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const start = parseVttTimestamp(match[1]);
  const end = parseVttTimestamp(match[2]);
  if (start === null || end === null) {
    return null;
  }
  return { start, end };
}

function parseVttTimestamp(value: string): number | null {
  const parts = value.split(":");
  if (parts.length === 3) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    if (![hours, minutes, seconds].every(Number.isFinite)) {
      return null;
    }
    return roundSeconds(hours * 3600 + minutes * 60 + seconds);
  }
  if (parts.length === 2) {
    const minutes = Number(parts[0]);
    const seconds = Number(parts[1]);
    if (![minutes, seconds].every(Number.isFinite)) {
      return null;
    }
    return roundSeconds(minutes * 60 + seconds);
  }
  return null;
}

function toBcp47(code: string): string {
  const trimmed = code.trim();
  if (trimmed === "" || trimmed === "und") {
    return "und";
  }
  const match = /^([a-zA-Z]{2,3})(?:[_-]([a-zA-Z]{2}))?/.exec(trimmed);
  if (match?.[1] === undefined) {
    return trimmed;
  }
  const lang = iso639ToBcp47(match[1].toLowerCase());
  if (match[2] === undefined) {
    return lang;
  }
  return `${lang}-${match[2].toUpperCase()}`;
}

function iso639ToBcp47(code: string): string {
  const three: Record<string, string> = {
    eng: "en",
    jpn: "ja",
    spa: "es",
    fra: "fr",
    deu: "de",
    zho: "zh",
    kor: "ko",
    por: "pt",
    ita: "it",
    und: "und",
  };
  return three[code] ?? code;
}

function firstGroup(re: RegExp, html: string): string | null {
  const match = re.exec(html);
  const body = match?.[1];
  if (body === undefined || body.trim() === "") {
    return null;
  }
  return body.trim();
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) {
    return null;
  }
  const unwrapped = stripScriptWrappers(raw);
  const candidates = [unwrapped, unescapeHtml(unwrapped)];
  for (const candidate of candidates) {
    try {
      const parsed = asRecord(JSON.parse(candidate));
      if (parsed !== null) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function stripScriptWrappers(raw: string): string {
  return raw.replace(/^<!--/, "").replace(/-->$/, "").trim();
}

function unescapeHtml(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&#x0*22;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function readString(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
