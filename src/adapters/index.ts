import { createFixtureAdapter } from "./tiktok/fixture.js";
import type { TranscriptAdapter } from "./types.js";

export type {
  AdapterErr,
  AdapterFailureCode,
  AdapterOk,
  AdapterRequest,
  AdapterResult,
  CreatorListOk,
  CreatorListRequest,
  CreatorListResult,
  TranscriptAdapter,
} from "./types.js";
export { createFixtureAdapter } from "./tiktok/fixture.js";
export { createLiveTikTokAdapter } from "./tiktok/index.js";

/** Unit tests and CI always use the fixture adapter. Live TikTok is a later PR. */
export function createAppAdapter(): TranscriptAdapter {
  return createFixtureAdapter();
}
