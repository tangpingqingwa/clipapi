import { randomUUID } from "node:crypto";
import type { CreatorListResult, TranscriptAdapter } from "../adapters/types.js";
import {
  chargeCredits,
  CREATOR_PAGE_CREDIT_COST,
  getCredits,
} from "../billing/credits.js";
import type { Key } from "../billing/keys.js";
import {
  CREATOR_LIST_TTL_MS,
  creatorListCacheKey,
  getCacheEntry,
  LATEST_TTL_MS,
  latestCacheKey,
  setCacheTombstone,
  setJsonCache,
} from "../cache/store.js";
import type { ClipApiDb } from "../db.js";
import type {
  CreatorVideoPage,
  Err,
  ErrorCode,
  Ok,
  Platform,
} from "../types.js";
import { isRetryableCode } from "./transcript.js";

export const CREATOR_VIDEOS_ROUTE = "/v1/creators/:handle/videos" as const;
export const CREATOR_LATEST_ROUTE = "/v1/creators/:handle/latest" as const;

export const LATEST_LIMIT = 15;
export const VIDEOS_DEFAULT_LIMIT = 10;
export const VIDEOS_MIN_LIMIT = 1;
export const VIDEOS_MAX_LIMIT = 20;

export type CreatorQuery = {
  handle: string;
  platform?: string;
  cursor?: string;
  limit?: string;
};

export type CreatorOutcome = Ok<CreatorVideoPage> | Err;

export type GetCreatorInput = {
  db: ClipApiDb;
  adapter: TranscriptAdapter;
  key: Key;
  query: CreatorQuery;
  requestId?: string;
};

const ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "Provide a creator handle.",
  unauthorized: "Missing or invalid API key.",
  payment_required: "This key has no credits remaining.",
  not_found: "This creator has no public uploads, or the handle is unknown.",
  no_transcript: "This video has no public caption track.",
  unsupported_platform: "This URL is not a supported short-video platform.",
  rate_limited: "Rate limit exceeded.",
  upstream_blocked: "The upstream platform blocked this request.",
  internal: "Internal error.",
};

export function normalizeCreatorHandle(handle: string): string | null {
  const normalized = handle.trim().replace(/^@+/, "").toLowerCase();
  if (normalized === "" || !/^[a-z0-9._]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export async function getLatestVideos(
  input: GetCreatorInput,
): Promise<CreatorOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const parsed = parseCreatorQuery(input.query, { latest: true });
  if (!parsed.ok) {
    return fail(parsed.code, requestId, parsed.message);
  }

  const cacheKey = latestCacheKey(parsed.platform, parsed.handle);
  const cached = readCachedPage(input.db, cacheKey);
  if (cached === "tombstone") {
    return fail("not_found", requestId);
  }
  if (cached !== null) {
    return okPage(cached, { cached: true, requestId, upstreamMs: 0 });
  }

  const fetched = await fetchPage(input.adapter, parsed, requestId);
  if ("error" in fetched) {
    if (fetched.error.code === "not_found") {
      setCacheTombstone(input.db, cacheKey, "not_found");
    }
    return fetched;
  }

  const page: CreatorVideoPage = {
    ...fetched.page,
    videos: fetched.page.videos.slice(0, LATEST_LIMIT),
    nextCursor: null,
  };
  setJsonCache(
    input.db,
    cacheKey,
    JSON.stringify(page),
    new Date(),
    LATEST_TTL_MS,
  );
  return okPage(page, {
    cached: false,
    requestId,
    upstreamMs: fetched.upstreamMs,
  });
}

export async function listCreatorVideos(
  input: GetCreatorInput,
): Promise<CreatorOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const parsed = parseCreatorQuery(input.query, { latest: false });
  if (!parsed.ok) {
    return fail(parsed.code, requestId, parsed.message);
  }

  const remaining = getCredits(input.db, input.key.id);
  if (remaining === null) {
    return fail("unauthorized", requestId);
  }
  if (remaining < CREATOR_PAGE_CREDIT_COST) {
    return fail("payment_required", requestId);
  }

  const cacheKey = creatorListCacheKey(
    parsed.platform,
    parsed.handle,
    parsed.cursor ?? "",
    parsed.limit,
  );
  const cached = readCachedPage(input.db, cacheKey);
  if (cached === "tombstone") {
    return fail("not_found", requestId);
  }
  if (cached !== null) {
    return succeedCharged(input, {
      data: cached,
      cached: true,
      requestId,
      upstreamMs: 0,
    });
  }

  const fetched = await fetchPage(input.adapter, parsed, requestId);
  if ("error" in fetched) {
    if (fetched.error.code === "not_found") {
      setCacheTombstone(input.db, cacheKey, "not_found");
    }
    return fetched;
  }

  setJsonCache(
    input.db,
    cacheKey,
    JSON.stringify(fetched.page),
    new Date(),
    CREATOR_LIST_TTL_MS,
  );
  return succeedCharged(input, {
    data: fetched.page,
    cached: false,
    requestId,
    upstreamMs: fetched.upstreamMs,
  });
}

type ParsedCreatorQuery = {
  platform: Platform;
  handle: string;
  cursor: string | undefined;
  limit: number;
};

type ParseCreatorFailure = {
  ok: false;
  code: Extract<ErrorCode, "invalid_request" | "unsupported_platform">;
  message: string;
};

function parseCreatorQuery(
  query: CreatorQuery,
  options: { latest: boolean },
): (ParsedCreatorQuery & { ok: true }) | ParseCreatorFailure {
  const handle = normalizeCreatorHandle(query.handle);
  if (handle === null) {
    return {
      ok: false,
      code: "invalid_request",
      message: "handle must be a public creator username, with or without @.",
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

  const cursor = trimToUndefined(query.cursor);
  if (cursor !== undefined && !/^[A-Za-z0-9._-]+$/.test(cursor)) {
    return {
      ok: false,
      code: "invalid_request",
      message: "cursor is not a valid page token.",
    };
  }

  let limit = options.latest ? LATEST_LIMIT : VIDEOS_DEFAULT_LIMIT;
  const rawLimit = trimToUndefined(query.limit);
  if (!options.latest && rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) {
      return {
        ok: false,
        code: "invalid_request",
        message: "limit must be an integer from 1 to 20.",
      };
    }
    limit = Number(rawLimit);
    if (limit < VIDEOS_MIN_LIMIT || limit > VIDEOS_MAX_LIMIT) {
      return {
        ok: false,
        code: "invalid_request",
        message: "limit must be an integer from 1 to 20.",
      };
    }
  }

  return {
    ok: true,
    platform: "tiktok",
    handle,
    cursor: options.latest ? undefined : cursor,
    limit,
  };
}

async function fetchPage(
  adapter: TranscriptAdapter,
  parsed: ParsedCreatorQuery,
  requestId: string,
): Promise<{ page: CreatorVideoPage; upstreamMs: number } | Err> {
  const started = performance.now();
  let result: CreatorListResult;
  try {
    result = await adapter.listCreatorVideos({
      platform: parsed.platform,
      handle: parsed.handle,
      cursor: parsed.cursor,
      limit: parsed.limit,
    });
  } catch {
    return fail("internal", requestId);
  }
  const upstreamMs = Math.max(0, Math.round(performance.now() - started));
  if (!result.ok) {
    return fail(result.code, requestId);
  }
  return { page: result.page, upstreamMs };
}

function succeedCharged(
  input: GetCreatorInput,
  ready: {
    data: CreatorVideoPage;
    cached: boolean;
    requestId: string;
    upstreamMs: number;
  },
): Ok<CreatorVideoPage> {
  const skipCharge =
    input.key.prefix === "ck_test" && process.env.CLIPAPI_TEST_KEYS_FREE === "1";
  let creditsCharged = 0;
  if (!skipCharge) {
    const charge = chargeCredits(input.db, {
      keyId: input.key.id,
      route: CREATOR_VIDEOS_ROUTE,
      credits: CREATOR_PAGE_CREDIT_COST,
      cached: ready.cached,
    });
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

function okPage(
  data: CreatorVideoPage,
  meta: { cached: boolean; requestId: string; upstreamMs: number },
): Ok<CreatorVideoPage> {
  return {
    data,
    meta: {
      cached: meta.cached,
      creditsCharged: 0,
      requestId: meta.requestId,
      upstreamMs: meta.upstreamMs,
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

function readCachedPage(
  db: ClipApiDb,
  cacheKey: string,
): CreatorVideoPage | "tombstone" | null {
  const cached = getCacheEntry(db, cacheKey);
  if (cached.hit && cached.kind === "tombstone") {
    return "tombstone";
  }
  if (cached.hit && cached.kind === "body") {
    const page = parseCachedPage(cached.body);
    if (page !== null) {
      return page;
    }
  }
  return null;
}

function parseCachedPage(body: string): CreatorVideoPage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.videos)) {
      return null;
    }
    return parsed as CreatorVideoPage;
  } catch {
    return null;
  }
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

function newRequestId(): string {
  return `req_${randomUUID()}`;
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
