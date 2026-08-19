import type { ClipApiDb } from "../db.js";
import type { ErrorCode, Platform } from "../types.js";

export const TRANSCRIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000;
export const NO_TRANSCRIPT_TTL_MS = 10 * 60 * 1000;
export const CREATOR_LIST_TTL_MS = 15 * 60 * 1000;
export const LATEST_TTL_MS = 10 * 60 * 1000;

export type CacheTombstoneCode = Extract<ErrorCode, "not_found" | "no_transcript">;

export type CacheLookup =
  | { hit: false }
  | { hit: true; kind: "body"; body: string }
  | { hit: true; kind: "tombstone"; errorCode: CacheTombstoneCode };

type CacheRow = {
  kind: string;
  body: string | null;
  error_code: string | null;
  expires_at: string;
};

export function transcriptCacheKey(
  platform: Platform,
  videoId: string,
  lang: string,
): string {
  return `transcript:${platform}:${videoId}:${lang}`;
}

export function creatorListCacheKey(
  platform: Platform,
  handle: string,
  cursor: string,
  limit: number,
): string {
  return `creator:${platform}:${handle}:${cursor}:${limit}`;
}

export function latestCacheKey(platform: Platform, handle: string): string {
  return `latest:${platform}:${handle}`;
}

export function getCacheEntry(
  db: ClipApiDb,
  cacheKey: string,
  now: Date = new Date(),
): CacheLookup {
  const row = db
    .prepare<[string], CacheRow>(
      `SELECT kind, body, error_code, expires_at
       FROM cache_entries WHERE cache_key = ?`,
    )
    .get(cacheKey);
  if (row === undefined || row.expires_at <= now.toISOString()) {
    return { hit: false };
  }
  if ((row.kind === "transcript" || row.kind === "json") && row.body !== null) {
    return { hit: true, kind: "body", body: row.body };
  }
  if (
    row.kind === "tombstone" &&
    (row.error_code === "not_found" || row.error_code === "no_transcript")
  ) {
    return { hit: true, kind: "tombstone", errorCode: row.error_code };
  }
  return { hit: false };
}

export function setTranscriptCache(
  db: ClipApiDb,
  cacheKey: string,
  body: string,
  now: Date = new Date(),
  ttlMs: number = TRANSCRIPT_TTL_MS,
): void {
  setCacheBody(db, cacheKey, body, now, ttlMs, "transcript");
}

export function setJsonCache(
  db: ClipApiDb,
  cacheKey: string,
  body: string,
  now: Date = new Date(),
  ttlMs: number,
): void {
  setCacheBody(db, cacheKey, body, now, ttlMs, "json");
}

function setCacheBody(
  db: ClipApiDb,
  cacheKey: string,
  body: string,
  now: Date,
  ttlMs: number,
  kind: "transcript" | "json",
): void {
  upsertCache(db, {
    cacheKey,
    kind,
    body,
    errorCode: null,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export function setCacheTombstone(
  db: ClipApiDb,
  cacheKey: string,
  errorCode: CacheTombstoneCode,
  now: Date = new Date(),
  ttlMs: number = errorCode === "not_found" ? NOT_FOUND_TTL_MS : NO_TRANSCRIPT_TTL_MS,
): void {
  upsertCache(db, {
    cacheKey,
    kind: "tombstone",
    body: null,
    errorCode,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

function upsertCache(
  db: ClipApiDb,
  entry: {
    cacheKey: string;
    kind: string;
    body: string | null;
    errorCode: string | null;
    expiresAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO cache_entries (cache_key, kind, body, error_code, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       kind = excluded.kind,
       body = excluded.body,
       error_code = excluded.error_code,
       expires_at = excluded.expires_at`,
  ).run(entry.cacheKey, entry.kind, entry.body, entry.errorCode, entry.expiresAt);
}
