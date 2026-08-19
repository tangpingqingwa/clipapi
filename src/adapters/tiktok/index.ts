import type { AdapterResult, TranscriptAdapter } from "../types.js";

/**
 * Live TikTok path is a later PR. This stub implements the adapter
 * contract without opening a network socket.
 */
export function createLiveTikTokAdapter(): TranscriptAdapter {
  return {
    resolveVideoId(ref: string): string {
      return ref;
    },
    async fetchTranscript(): Promise<AdapterResult> {
      return { ok: false, code: "upstream_blocked" };
    },
  };
}
