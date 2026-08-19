import type { CreatorVideoPage, Platform, Transcript } from "../types.js";

export type AdapterRequest = {
  platform: Platform;
  videoId: string;
  url?: string;
  lang?: string;
};

export type CreatorListRequest = {
  platform: Platform;
  handle: string;
  cursor?: string;
  limit: number;
};

export type AdapterFailureCode =
  | "not_found"
  | "no_transcript"
  | "upstream_blocked"
  | "unsupported_platform";

export type AdapterOk = {
  ok: true;
  transcript: Transcript;
};

export type AdapterErr = {
  ok: false;
  code: AdapterFailureCode;
};

export type AdapterResult = AdapterOk | AdapterErr;

export type CreatorListOk = {
  ok: true;
  page: CreatorVideoPage;
};

export type CreatorListResult = CreatorListOk | AdapterErr;

export type TranscriptAdapter = {
  /** Map a short code or raw id to the canonical video id when known. */
  resolveVideoId(ref: string): string;
  fetchTranscript(request: AdapterRequest): Promise<AdapterResult>;
  listCreatorVideos(request: CreatorListRequest): Promise<CreatorListResult>;
};
