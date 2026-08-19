import { randomUUID } from "node:crypto";
import type { AdapterResult, TranscriptAdapter } from "../adapters/types.js";
import { chargeCredits, getCredits, TRANSCRIPT_CREDIT_COST } from "../billing/credits.js";
import type { Key } from "../billing/keys.js";
import {
  getCacheEntry,
  setCacheTombstone,
  setTranscriptCache,
  transcriptCacheKey,
} from "../cache/store.js";
import type { ClipApiDb } from "../db.js";
import type { Err, ErrorCode, Ok, Platform, Transcript } from "../types.js";

export const TRANSCRIPT_ROUTE = "/v1/transcript" as const;

export type TranscriptQuery = {
  url?: string;
  videoId?: string;
  platform?: string;
  lang?: string;
  format?: string;
};

export type ParsedTranscriptQuery = {
  platform: Platform;
  videoId: string;
  lang: string;
};

export type ParseFailure = {
  ok: false;
  code: Extract<ErrorCode, "invalid_request" | "unsupported_platform">;
  message: string;
};

export type ParseSuccess = {
  ok: true;
} & ParsedTranscriptQuery;

export type ParseResult = ParseSuccess | ParseFailure;

export type TranscriptOutcome = Ok<Transcript> | Err;

export type GetTranscriptInput = {
  db: ClipApiDb;
  adapter: TranscriptAdapter;
  key: Key;
  query: TranscriptQuery;
  requestId?: string;
};

const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

const ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "Provide a url or video_id query parameter.",
  unauthorized: "Missing or invalid API key.",
  payment_required: "This key has no credits remaining.",
  not_found: "This video is deleted or private.",
  no_transcript: "This video has no public caption track.",
  unsupported_platform: "This URL is not a supported short-video platform.",
  rate_limited: "Rate limit exceeded.",
  upstream_blocked: "The upstream platform blocked this request.",
  internal: "Internal error.",
};

export function isRetryableCode(code: ErrorCode): boolean {
  return code === "rate_limited" || code === "upstream_blocked" || code === "internal";
}

export function parseTranscriptQuery(query: TranscriptQuery): ParseResult {
  const format = trimToUndefined(query.format);
  if (format !== undefined && format !== "json") {
    return {
      ok: false,
      code: "invalid_request",
      message: `format ${format} is not supported.`,
    };
  }

  const requested = parseRequestedPlatform(query.platform);
  if (requested === "invalid") {
    return {
      ok: false,
      code: "invalid_request",
      message: "platform must be tiktok, reels, or shorts.",
    };
  }
  if (requested === "reels" || requested === "shorts") {
    return {
      ok: false,
      code: "unsupported_platform",
      message: ERROR_MESSAGE.unsupported_platform,
    };
  }

  const urlRaw = trimToUndefined(query.url);
  const idRaw = trimToUndefined(query.videoId);
  if (urlRaw === undefined && idRaw === undefined) {
    return {
      ok: false,
      code: "invalid_request",
      message: ERROR_MESSAGE.invalid_request,
    };
  }

  let videoId: string | undefined;
  let shortCode = false;

  if (urlRaw !== undefined) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlRaw);
    } catch {
      return {
        ok: false,
        code: "invalid_request",
        message: "url is not a valid URL.",
      };
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return {
        ok: false,
        code: "invalid_request",
        message: "url is not a valid URL.",
      };
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (!TIKTOK_HOSTS.has(host)) {
      return {
        ok: false,
        code: "unsupported_platform",
        message: ERROR_MESSAGE.unsupported_platform,
      };
    }
    const extracted = extractTikTokVideoRef(parsedUrl);
    if (extracted === null) {
      return {
        ok: false,
        code: "invalid_request",
        message: "url does not contain a TikTok video id.",
      };
    }
    videoId = extracted.id;
    shortCode = extracted.kind === "short";
  }

  if (idRaw !== undefined) {
    if (!/^\d+$/.test(idRaw)) {
      return {
        ok: false,
        code: "invalid_request",
        message: "video_id must be a numeric TikTok id.",
      };
    }
    if (videoId !== undefined && !shortCode && videoId !== idRaw) {
      return {
        ok: false,
        code: "invalid_request",
        message: "url and video_id refer to different videos.",
      };
    }
    videoId = idRaw;
  }

  if (videoId === undefined) {
    return {
      ok: false,
      code: "invalid_request",
      message: ERROR_MESSAGE.invalid_request,
    };
  }

  return {
    ok: true,
    platform: "tiktok",
    videoId,
    lang: trimToUndefined(query.lang) ?? "*",
  };
}

export async function getTranscript(
  input: GetTranscriptInput,
): Promise<TranscriptOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const parsed = parseTranscriptQuery(input.query);
  if (!parsed.ok) {
    return fail(parsed.code, requestId, parsed.message);
  }

  const remaining = getCredits(input.db, input.key.id);
  if (remaining === null) {
    return fail("unauthorized", requestId);
  }
  if (remaining < TRANSCRIPT_CREDIT_COST) {
    return fail("payment_required", requestId);
  }

  const videoId = input.adapter.resolveVideoId(parsed.videoId);
  const cacheKey = transcriptCacheKey(parsed.platform, videoId, parsed.lang);
  const cached = getCacheEntry(input.db, cacheKey);
  if (cached.hit && cached.kind === "body") {
    const data = readCachedTranscript(cached.body);
    if (data !== null) {
      return succeed(input, {
        data,
        cached: true,
        requestId,
        upstreamMs: 0,
      });
    }
  }
  if (cached.hit && cached.kind === "tombstone") {
    return fail(cached.errorCode, requestId);
  }

  const started = performance.now();
  let adapterResult: AdapterResult;
  try {
    adapterResult = await input.adapter.fetchTranscript({
      platform: parsed.platform,
      videoId,
      url: trimToUndefined(input.query.url),
      lang: parsed.lang === "*" ? undefined : parsed.lang,
    });
  } catch {
    return fail("internal", requestId);
  }
  const upstreamMs = Math.max(0, Math.round(performance.now() - started));

  if (!adapterResult.ok) {
    if (adapterResult.code === "not_found" || adapterResult.code === "no_transcript") {
      setCacheTombstone(input.db, cacheKey, adapterResult.code);
    }
    return fail(adapterResult.code, requestId);
  }

  if (adapterResult.transcript.transcript.length === 0) {
    setCacheTombstone(input.db, cacheKey, "no_transcript");
    return fail("no_transcript", requestId);
  }

  setTranscriptCache(input.db, cacheKey, JSON.stringify(adapterResult.transcript));
  return succeed(input, {
    data: adapterResult.transcript,
    cached: false,
    requestId,
    upstreamMs,
  });
}

function succeed(
  input: GetTranscriptInput,
  ready: {
    data: Transcript;
    cached: boolean;
    requestId: string;
    upstreamMs: number;
  },
): Ok<Transcript> {
  const skipCharge =
    input.key.prefix === "ck_test" && process.env.CLIPAPI_TEST_KEYS_FREE === "1";
  let creditsCharged = 0;
  if (!skipCharge) {
    const charge = chargeCredits(input.db, {
      keyId: input.key.id,
      route: TRANSCRIPT_ROUTE,
      credits: TRANSCRIPT_CREDIT_COST,
      cached: ready.cached,
    });
    // Undercharge is allowed if the debit fails after we already have a body.
    creditsCharged = charge.ok ? charge.charged : 0;
  }
  return {
    data: ready.data,
    meta: {
      cached: ready.cached,
      creditsCharged,
      requestId: ready.requestId,
      upstreamMs: ready.upstreamMs,
    },
  };
}

function fail(code: ErrorCode, requestId: string, message?: string): Err {
  return {
    error: {
      code,
      message: message ?? ERROR_MESSAGE[code],
      retryable: isRetryableCode(code),
    },
    meta: { creditsCharged: 0, requestId },
  };
}

function newRequestId(): string {
  return `req_${randomUUID()}`;
}

function parseRequestedPlatform(
  value: string | undefined,
): Platform | undefined | "invalid" {
  const platform = trimToUndefined(value);
  if (platform === undefined) {
    return undefined;
  }
  if (platform === "tiktok" || platform === "reels" || platform === "shorts") {
    return platform;
  }
  return "invalid";
}

function extractTikTokVideoRef(
  url: URL,
): { id: string; kind: "numeric" | "short" } | null {
  const path = url.pathname.replace(/\/+$/, "");
  const video = /\/video\/(\d+)/.exec(path);
  if (video?.[1] !== undefined) {
    return { id: video[1], kind: "numeric" };
  }
  const embed = /\/v\/(\d+)/.exec(path);
  if (embed?.[1] !== undefined) {
    return { id: embed[1], kind: "numeric" };
  }
  const share = /\/t\/([A-Za-z0-9]+)$/.exec(path);
  if (share?.[1] !== undefined) {
    return { id: share[1], kind: "short" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    const short = /^\/([A-Za-z0-9]+)$/.exec(path);
    if (short?.[1] !== undefined) {
      return { id: short[1], kind: "short" };
    }
  }
  return null;
}

function readCachedTranscript(body: string): Transcript | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.transcript)) {
      return null;
    }
    if (parsed.transcript.length === 0) {
      return null;
    }
    return parsed as Transcript;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
