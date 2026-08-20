import { shouldUseLiveTikTok } from "../config.js";
import { createFixtureAdapter } from "./tiktok/fixture.js";
import { createLiveTikTokAdapter } from "./tiktok/index.js";
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

/**
 * Default is the fixture adapter. Live public TikTok is opt-in via
 * CLIPAPI_LIVE=1 and is forced off when CLIPAPI_FIXTURE_ONLY=1 (CI / test.sh).
 */
export function createAppAdapter(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptAdapter {
  if (shouldUseLiveTikTok(env)) {
    return createLiveTikTokAdapter();
  }
  return createFixtureAdapter();
}
