import type {
  AdapterFailureCode,
  AdapterResult,
  CreatorListResult,
  TranscriptAdapter,
} from "../types.js";
import {
  isAllowedSubtitleUrl,
  parseSubtitleBody,
  parseTikTokCreatorPage,
  parseTikTokVideoPage,
} from "./parse.js";

/** BUILD §12: 8s upstream budget on the live path. */
export const LIVE_FETCH_TIMEOUT_MS = 8000;

export const LIVE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const TIKTOK_ORIGIN = "https://www.tiktok.com";
const VM_ORIGIN = "https://vm.tiktok.com";

const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

export type FetchLike = typeof fetch;

export type LiveTikTokAdapterOptions = {
  fetch?: FetchLike;
  userAgent?: string;
  timeoutMs?: number;
};

type FetchTextResult =
  | { ok: true; body: string }
  | { ok: false; code: AdapterFailureCode };

/**
 * Public TikTok HTML → Transcript / creator page. Never throws; failures
 * are AdapterResult. Never invents caption lines or upload rows.
 */
export function createLiveTikTokAdapter(
  options: LiveTikTokAdapterOptions = {},
): TranscriptAdapter {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const userAgent = options.userAgent ?? LIVE_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? LIVE_FETCH_TIMEOUT_MS;

  return {
    resolveVideoId(ref: string): string {
      return ref;
    },
    async fetchTranscript(request): Promise<AdapterResult> {
      try {
        if (request.platform !== "tiktok") {
          return { ok: false, code: "unsupported_platform" };
        }
        const pageUrl = pageUrlFor(request.url, request.videoId);
        if (pageUrl === null) {
          return { ok: false, code: "unsupported_platform" };
        }
        const page = await fetchText(fetchFn, pageUrl, userAgent, timeoutMs, "html");
        if (!page.ok) {
          return { ok: false, code: page.code };
        }
        const parsed = parseTikTokVideoPage(page.body, request.videoId, request.lang);
        if (!parsed.ok) {
          return parsed;
        }
        let cues = parsed.cues;
        if (cues.length === 0 && parsed.subtitleUrl !== null) {
          const subtitle = await fetchSubtitle(
            fetchFn,
            parsed.subtitleUrl,
            userAgent,
            timeoutMs,
          );
          if (!subtitle.ok) {
            return { ok: false, code: subtitle.code };
          }
          cues = parseSubtitleBody(subtitle.body);
        }
        if (cues.length === 0) {
          return { ok: false, code: "no_transcript" };
        }
        return {
          ok: true,
          transcript: {
            platform: "tiktok",
            videoId: parsed.videoId,
            canonicalUrl: parsed.canonicalUrl,
            kind: parsed.kind,
            language: parsed.language,
            durationMs: parsed.durationMs,
            author: parsed.author,
            metadata: parsed.metadata,
            source: parsed.source,
            transcript: cues,
          },
        };
      } catch {
        return { ok: false, code: "upstream_blocked" };
      }
    },
    async listCreatorVideos(request): Promise<CreatorListResult> {
      try {
        if (request.platform !== "tiktok") {
          return { ok: false, code: "unsupported_platform" };
        }
        const handle = request.handle.trim().replace(/^@+/, "");
        if (handle === "" || !/^[A-Za-z0-9._]+$/.test(handle)) {
          return { ok: false, code: "not_found" };
        }
        const pageUrl = `${TIKTOK_ORIGIN}/@${encodeURIComponent(handle)}`;
        const page = await fetchText(fetchFn, pageUrl, userAgent, timeoutMs, "html");
        if (!page.ok) {
          return { ok: false, code: page.code };
        }
        return parseTikTokCreatorPage(
          page.body,
          handle,
          request.cursor,
          request.limit,
        );
      } catch {
        return { ok: false, code: "upstream_blocked" };
      }
    },
  };
}

async function fetchSubtitle(
  fetchFn: FetchLike,
  rawUrl: string,
  userAgent: string,
  timeoutMs: number,
): Promise<FetchTextResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { ok: false, code: "no_transcript" };
  }
  if (!isAllowedSubtitleUrl(parsedUrl)) {
    return { ok: false, code: "no_transcript" };
  }
  const fetched = await fetchText(
    fetchFn,
    parsedUrl.toString(),
    userAgent,
    timeoutMs,
    "subtitle",
  );
  if (!fetched.ok && fetched.code === "not_found") {
    return { ok: false, code: "no_transcript" };
  }
  return fetched;
}

async function fetchText(
  fetchFn: FetchLike,
  url: string,
  userAgent: string,
  timeoutMs: number,
  kind: "html" | "subtitle",
): Promise<FetchTextResult> {
  let response: Response;
  try {
    response = await doFetch(fetchFn, url, userAgent, timeoutMs);
    // BUILD §12: one retry on 502/503 only — not on timeout, 429, or other 5xx.
    if (response.status === 502 || response.status === 503) {
      response = await doFetch(fetchFn, url, userAgent, timeoutMs);
    }
  } catch {
    return { ok: false, code: "upstream_blocked" };
  }

  if (response.status === 404 || response.status === 410) {
    return { ok: false, code: kind === "html" ? "not_found" : "no_transcript" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: "upstream_blocked" };
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, code: "upstream_blocked" };
  }
  if (body.trim() === "") {
    return {
      ok: false,
      code: kind === "html" ? "upstream_blocked" : "no_transcript",
    };
  }
  return { ok: true, body };
}

async function doFetch(
  fetchFn: FetchLike,
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<Response> {
  return fetchFn(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function pageUrlFor(url: string | undefined, videoId: string): string | null {
  if (url !== undefined && url !== "") {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (
        TIKTOK_HOSTS.has(host) &&
        (parsed.protocol === "http:" || parsed.protocol === "https:")
      ) {
        parsed.protocol = "https:";
        return parsed.toString();
      }
      return null;
    } catch {
      return null;
    }
  }
  if (/^\d+$/.test(videoId)) {
    return `${TIKTOK_ORIGIN}/@i/video/${videoId}`;
  }
  if (/^[A-Za-z0-9]+$/.test(videoId)) {
    return `${VM_ORIGIN}/${videoId}`;
  }
  return null;
}
