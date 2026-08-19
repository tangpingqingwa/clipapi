import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cue, Platform, Transcript } from "../../types.js";
import type {
  AdapterFailureCode,
  AdapterResult,
  TranscriptAdapter,
} from "../types.js";

export const DEFAULT_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures",
);

const FAILURE_CODES: ReadonlySet<AdapterFailureCode> = new Set([
  "not_found",
  "no_transcript",
  "upstream_blocked",
  "unsupported_platform",
]);

type FixtureFile = {
  videoId: string;
  shortCodes?: string[];
  adapter: AdapterResult;
};

type FixtureIndex = {
  byId: Map<string, AdapterResult>;
  byShort: Map<string, string>;
};

export type FixtureAdapterOptions = {
  dir?: string;
};

export function createFixtureAdapter(
  options: FixtureAdapterOptions = {},
): TranscriptAdapter {
  const index = loadFixtureIndex(options.dir ?? DEFAULT_FIXTURE_DIR);
  return {
    resolveVideoId(ref: string): string {
      return index.byShort.get(ref) ?? ref;
    },
    async fetchTranscript(request): Promise<AdapterResult> {
      const videoId = index.byShort.get(request.videoId) ?? request.videoId;
      return index.byId.get(videoId) ?? { ok: false, code: "not_found" };
    },
  };
}

export function loadFixtureIndex(dir: string): FixtureIndex {
  const byId = new Map<string, AdapterResult>();
  const byShort = new Map<string, string>();
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const file of files) {
    const parsed = parseFixtureFile(join(dir, file), file);
    if (byId.has(parsed.videoId)) {
      throw new Error(`duplicate fixture videoId ${parsed.videoId} in ${file}`);
    }
    byId.set(parsed.videoId, parsed.adapter);
    for (const code of parsed.shortCodes ?? []) {
      if (byShort.has(code)) {
        throw new Error(`duplicate fixture short code ${code} in ${file}`);
      }
      byShort.set(code, parsed.videoId);
    }
  }
  return { byId, byShort };
}

function parseFixtureFile(path: string, file: string): FixtureFile {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) {
    throw new Error(`fixture ${file} must be an object`);
  }
  if (typeof raw.videoId !== "string" || raw.videoId === "") {
    throw new Error(`fixture ${file} is missing videoId`);
  }
  const shortCodes = parseShortCodes(raw.shortCodes, file);
  const adapter = parseAdapterResult(raw.adapter, file);
  return { videoId: raw.videoId, shortCodes, adapter };
}

function parseShortCodes(value: unknown, file: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`fixture ${file} shortCodes must be string[]`);
  }
  return value;
}

function parseAdapterResult(value: unknown, file: string): AdapterResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error(`fixture ${file} adapter.ok must be boolean`);
  }
  if (value.ok === false) {
    if (
      typeof value.code !== "string" ||
      !FAILURE_CODES.has(value.code as AdapterFailureCode)
    ) {
      throw new Error(`fixture ${file} has an unknown adapter error code`);
    }
    return { ok: false, code: value.code as AdapterFailureCode };
  }
  return { ok: true, transcript: parseTranscript(value.transcript, file) };
}

function parseTranscript(value: unknown, file: string): Transcript {
  if (!isRecord(value)) {
    throw new Error(`fixture ${file} transcript must be an object`);
  }
  const platform = value.platform;
  if (platform !== "tiktok" && platform !== "reels" && platform !== "shorts") {
    throw new Error(`fixture ${file} has an invalid platform`);
  }
  if (typeof value.videoId !== "string" || value.videoId === "") {
    throw new Error(`fixture ${file} transcript.videoId is required`);
  }
  if (typeof value.canonicalUrl !== "string" || value.canonicalUrl === "") {
    throw new Error(`fixture ${file} transcript.canonicalUrl is required`);
  }
  const kind = value.kind;
  if (kind !== "video" && kind !== "slideshow" && kind !== "unknown") {
    throw new Error(`fixture ${file} has an invalid kind`);
  }
  if (typeof value.language !== "string" || value.language === "") {
    throw new Error(`fixture ${file} transcript.language is required`);
  }
  if (value.durationMs !== null && typeof value.durationMs !== "number") {
    throw new Error(`fixture ${file} transcript.durationMs must be number|null`);
  }
  if (!isRecord(value.author)) {
    throw new Error(`fixture ${file} transcript.author is required`);
  }
  if (!isRecord(value.metadata)) {
    throw new Error(`fixture ${file} transcript.metadata is required`);
  }
  const source = value.source;
  if (
    source !== "platform_caption" &&
    source !== "platform_asr" &&
    source !== "on_screen"
  ) {
    throw new Error(`fixture ${file} has an invalid source`);
  }
  if (!Array.isArray(value.transcript)) {
    throw new Error(`fixture ${file} transcript.transcript must be an array`);
  }
  return {
    platform: platform as Platform,
    videoId: value.videoId,
    canonicalUrl: value.canonicalUrl,
    kind,
    language: value.language,
    durationMs: value.durationMs,
    author: {
      handle: asNullableString(value.author.handle, `${file} author.handle`),
      id: asNullableString(value.author.id, `${file} author.id`),
    },
    metadata: {
      description: asNullableString(
        value.metadata.description,
        `${file} metadata.description`,
      ),
      createTime: asNullableString(
        value.metadata.createTime,
        `${file} metadata.createTime`,
      ),
      musicTitle: asNullableString(
        value.metadata.musicTitle,
        `${file} metadata.musicTitle`,
      ),
    },
    source,
    transcript: value.transcript.map((cue, index) =>
      parseCue(cue, file, index),
    ),
  };
}

function parseCue(value: unknown, file: string, index: number): Cue {
  if (!isRecord(value)) {
    throw new Error(`fixture ${file} cue ${index} must be an object`);
  }
  if (typeof value.text !== "string") {
    throw new Error(`fixture ${file} cue ${index} text must be a string`);
  }
  if (typeof value.start !== "number" || !Number.isFinite(value.start)) {
    throw new Error(`fixture ${file} cue ${index} start must be a number`);
  }
  if (value.duration !== null && typeof value.duration !== "number") {
    throw new Error(
      `fixture ${file} cue ${index} duration must be number|null`,
    );
  }
  return {
    text: value.text,
    start: value.start,
    duration: value.duration,
  };
}

function asNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be string|null`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
