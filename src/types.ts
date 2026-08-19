export type Platform = "tiktok" | "reels" | "shorts";

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "payment_required"
  | "not_found"
  | "no_transcript"
  | "unsupported_platform"
  | "rate_limited"
  | "upstream_blocked"
  | "internal";

export const ERROR_CODES: readonly ErrorCode[] = [
  "invalid_request",
  "unauthorized",
  "payment_required",
  "not_found",
  "no_transcript",
  "unsupported_platform",
  "rate_limited",
  "upstream_blocked",
  "internal",
];

export type Cue = { text: string; start: number; duration: number | null };

export type Transcript = {
  platform: Platform;
  videoId: string;
  canonicalUrl: string;
  kind: "video" | "slideshow" | "unknown";
  language: string;
  durationMs: number | null;
  author: { handle: string | null; id: string | null };
  metadata: {
    description: string | null;
    createTime: string | null;
    musicTitle: string | null;
  };
  source: "platform_caption" | "platform_asr" | "on_screen";
  transcript: Cue[];
};

export type Ok<T> = {
  data: T;
  meta: { cached: boolean; creditsCharged: number; requestId: string; upstreamMs: number };
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};

export type CreatorVideo = {
  videoId: string;
  title: string | null;
  description: string | null;
  author: { handle: string | null; id: string | null };
  lengthText: string | null;
  hasCaptions: boolean | null;
  url: string;
  createTime: string | null;
};

export type CreatorVideoPage = {
  handle: string;
  platform: Platform;
  videos: CreatorVideo[];
  nextCursor: string | null;
};
