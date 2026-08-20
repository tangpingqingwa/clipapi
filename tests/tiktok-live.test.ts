import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createAppAdapter } from "../src/adapters/index.js";
import {
  createLiveTikTokAdapter,
  LIVE_FETCH_TIMEOUT_MS,
  LIVE_USER_AGENT,
  type FetchLike,
} from "../src/adapters/tiktok/index.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { shouldUseLiveTikTok } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Transcript } from "../src/types.js";

const HTML_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/html");
const VIDEO_ID = "7123456789012345678";
const NO_CAPTION_ID = "7987654321098765432";
const DELETED_ID = "7000000000000000001";
const KEY = "ck_test_live_adapter";

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

type OkBody = {
  data: Transcript;
  meta: { cached: boolean; creditsCharged: number; requestId: string; upstreamMs: number };
};

function snippet(name: string): string {
  return readFileSync(join(HTML_DIR, name), "utf8");
}

function jsonHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

function textResponse(body: string, status = 200, url?: string): Response {
  const response = new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  if (url !== undefined) {
    Object.defineProperty(response, "url", { value: url });
  }
  return response;
}

test("LIVE_FETCH_TIMEOUT_MS is the BUILD 8s budget", () => {
  assert.equal(LIVE_FETCH_TIMEOUT_MS, 8000);
});

test("CLIPAPI_LIVE is ignored when CLIPAPI_FIXTURE_ONLY=1", () => {
  assert.equal(shouldUseLiveTikTok({}), false);
  assert.equal(shouldUseLiveTikTok({ CLIPAPI_LIVE: "1" }), true);
  assert.equal(shouldUseLiveTikTok({ CLIPAPI_LIVE: "true" }), false);
  assert.equal(
    shouldUseLiveTikTok({ CLIPAPI_LIVE: "1", CLIPAPI_FIXTURE_ONLY: "1" }),
    false,
  );
  assert.equal(shouldUseLiveTikTok({ CLIPAPI_FIXTURE_ONLY: "1" }), false);
});

test("createAppAdapter stays on fixtures by default and when CI sets FIXTURE_ONLY", async () => {
  const def = createAppAdapter({});
  const defResult = await def.fetchTranscript({
    platform: "tiktok",
    videoId: VIDEO_ID,
  });
  assert.equal(defResult.ok, true);

  const fixture = createAppAdapter({ CLIPAPI_FIXTURE_ONLY: "1", CLIPAPI_LIVE: "1" });
  const captioned = await fixture.fetchTranscript({
    platform: "tiktok",
    videoId: VIDEO_ID,
  });
  assert.equal(captioned.ok, true);
  if (captioned.ok) {
    assert.ok(captioned.transcript.transcript.length >= 1);
  }

  const live = createAppAdapter({ CLIPAPI_LIVE: "1" });
  const creators = await live.listCreatorVideos({
    platform: "reels",
    handle: "clipapi_fixture",
    limit: 10,
  });
  assert.equal(creators.ok, false);
  if (!creators.ok) {
    assert.equal(creators.code, "unsupported_platform");
  }
});

test("live adapter parses captioned HTML+VTT via injected fetch, never the network", async () => {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const headers = jsonHeaders(init);
    assert.equal(headers.get("user-agent"), LIVE_USER_AGENT);
    assert.equal(init?.signal instanceof AbortSignal, true);
    if (url.includes("/video/")) {
      return textResponse(snippet("captioned.html"), 200, url);
    }
    if (url.includes("captioned.vtt")) {
      return textResponse(snippet("captioned.vtt"), 200, url);
    }
    throw new Error(`unexpected url ${url}`);
  };

  const adapter = createLiveTikTokAdapter({ fetch: fetchFn });
  const result = await adapter.fetchTranscript({
    platform: "tiktok",
    videoId: VIDEO_ID,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.transcript.videoId, VIDEO_ID);
    assert.equal(result.transcript.source, "platform_caption");
    assert.equal(result.transcript.transcript.length, 2);
    assert.equal(result.transcript.transcript[0]?.text, "Stop fighting TikTok blocks.");
    assert.equal(result.transcript.author.handle, "clipapi_fixture");
  }
  assert.equal(calls.length, 2);
  assert.equal(calls.some((url) => url.includes("tiktok.com") && url.includes(VIDEO_ID)), true);
});

test("live adapter retries once on 502 then succeeds", async () => {
  let pageAttempts = 0;
  const fetchFn: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("/video/")) {
      pageAttempts += 1;
      if (pageAttempts === 1) {
        return textResponse("bad gateway", 502);
      }
      return textResponse(snippet("captioned.html"));
    }
    return textResponse(snippet("captioned.vtt"));
  };
  const result = await createLiveTikTokAdapter({ fetch: fetchFn }).fetchTranscript({
    platform: "tiktok",
    videoId: VIDEO_ID,
  });
  assert.equal(result.ok, true);
  assert.equal(pageAttempts, 2);
});

test("live adapter retries once on 503 and maps a second 503 to upstream_blocked", async () => {
  let attempts = 0;
  const fetchFn: FetchLike = async () => {
    attempts += 1;
    return textResponse("unavailable", 503);
  };
  const result = await createLiveTikTokAdapter({ fetch: fetchFn }).fetchTranscript({
    platform: "tiktok",
    videoId: VIDEO_ID,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "upstream_blocked");
  }
  assert.equal(attempts, 2);
});

test("live adapter does not retry 500 or 429", async () => {
  for (const status of [500, 429, 403]) {
    let attempts = 0;
    const fetchFn: FetchLike = async () => {
      attempts += 1;
      return textResponse("nope", status);
    };
    const result = await createLiveTikTokAdapter({ fetch: fetchFn }).fetchTranscript({
      platform: "tiktok",
      videoId: VIDEO_ID,
    });
    assert.equal(result.ok, false, String(status));
    if (!result.ok) {
      assert.equal(result.code, "upstream_blocked");
    }
    assert.equal(attempts, 1, String(status));
  }
});

test("timeouts and thrown fetch errors are upstream_blocked with no retry", async () => {
  let attempts = 0;
  const fetchFn: FetchLike = async () => {
    attempts += 1;
    throw new DOMException("The operation was aborted.", "TimeoutError");
  };
  const result = await createLiveTikTokAdapter({
    fetch: fetchFn,
    timeoutMs: 8,
  }).fetchTranscript({
    platform: "tiktok",
    videoId: VIDEO_ID,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "upstream_blocked");
  }
  assert.equal(attempts, 1);
});

test("404 page is not_found; empty subtitle body is no_transcript with 0 cues", async () => {
  const notFound = await createLiveTikTokAdapter({
    fetch: async () => textResponse("gone", 404),
  }).fetchTranscript({ platform: "tiktok", videoId: DELETED_ID });
  assert.equal(notFound.ok, false);
  if (!notFound.ok) {
    assert.equal(notFound.code, "not_found");
  }

  const emptySubs: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("/video/")) {
      return textResponse(snippet("captioned.html"));
    }
    return textResponse("WEBVTT\n\n", 200);
  };
  const empty = await createLiveTikTokAdapter({ fetch: emptySubs }).fetchTranscript({
    platform: "tiktok",
    videoId: VIDEO_ID,
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.code, "no_transcript");
  }
});

test("no-caption and captcha snippets map to SPEC codes; live adapter never throws", async () => {
  const noCaption = await createLiveTikTokAdapter({
    fetch: async () => textResponse(snippet("no_caption.html")),
  }).fetchTranscript({ platform: "tiktok", videoId: NO_CAPTION_ID });
  assert.equal(noCaption.ok, false);
  if (!noCaption.ok) {
    assert.equal(noCaption.code, "no_transcript");
  }

  const blocked = await createLiveTikTokAdapter({
    fetch: async () => textResponse(snippet("blocked.html")),
  }).fetchTranscript({ platform: "tiktok", videoId: VIDEO_ID });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.code, "upstream_blocked");
  }

  const deleted = await createLiveTikTokAdapter({
    fetch: async () => textResponse(snippet("deleted.html")),
  }).fetchTranscript({ platform: "tiktok", videoId: DELETED_ID });
  assert.equal(deleted.ok, false);
  if (!deleted.ok) {
    assert.equal(deleted.code, "not_found");
  }

  await assert.doesNotReject(async () => {
    await createLiveTikTokAdapter({
      fetch: async () => {
        throw new Error("socket hang up");
      },
    }).fetchTranscript({ platform: "tiktok", videoId: VIDEO_ID });
  });
});

test("live creator list parses injected profile HTML and does not invent videos", async () => {
  const listed = await createLiveTikTokAdapter({
    fetch: async (input) => {
      const url = String(input);
      assert.match(url, /tiktok\.com\/@clipapi_fixture$/);
      return textResponse(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
        __DEFAULT_SCOPE__: {
          "webapp.user-detail": {
            statusCode: 0,
            userInfo: {
              user: { uniqueId: "clipapi_fixture", id: "user_captioned" },
              itemList: [
                { id: VIDEO_ID, desc: "listed", createTime: 1711972800, video: { duration: 8 } },
              ],
            },
          },
        },
      })}</script>`);
    },
  }).listCreatorVideos({
    platform: "tiktok",
    handle: "clipapi_fixture",
    limit: 15,
  });
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.equal(listed.page.videos.length, 1);
    assert.equal(listed.page.videos[0]?.videoId, VIDEO_ID);
  }

  const empty = await createLiveTikTokAdapter({
    fetch: async () =>
      textResponse(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
        __DEFAULT_SCOPE__: {
          "webapp.user-detail": {
            statusCode: 0,
            userInfo: {
              user: { uniqueId: "nasa", id: "1" },
              itemList: [],
            },
          },
        },
      })}</script>`),
  }).listCreatorVideos({ platform: "tiktok", handle: "nasa", limit: 15 });
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.page.videos.length, 0);
  }

  const missing = await createLiveTikTokAdapter({
    fetch: async () =>
      textResponse(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
        __DEFAULT_SCOPE__: {
          "webapp.user-detail": { statusCode: 10221, statusMsg: "user banned" },
        },
      })}</script>`),
  }).listCreatorVideos({
    platform: "tiktok",
    handle: "missing_handle",
    limit: 15,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "not_found");
  }
});

test("reels requests and off-platform URLs are unsupported_platform", async () => {
  const adapter = createLiveTikTokAdapter({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  const reels = await adapter.fetchTranscript({
    platform: "reels",
    videoId: VIDEO_ID,
  });
  assert.equal(reels.ok, false);
  if (!reels.ok) {
    assert.equal(reels.code, "unsupported_platform");
  }
  const youtube = await adapter.fetchTranscript({
    platform: "tiktok",
    videoId: VIDEO_ID,
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  assert.equal(youtube.ok, false);
  if (!youtube.ok) {
    assert.equal(youtube.code, "unsupported_platform");
  }
});

test("subtitle URLs off TikTok CDN are no_transcript and are not fetched", async () => {
  const poisoned = snippet("captioned.html").replace(
    "https://v16-webapp-prime.tiktok.com/captions/captioned.vtt",
    "https://evil.example/steal.vtt",
  );
  const urls: string[] = [];
  const result = await createLiveTikTokAdapter({
    fetch: async (input) => {
      urls.push(String(input));
      return textResponse(poisoned);
    },
  }).fetchTranscript({ platform: "tiktok", videoId: VIDEO_ID });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "no_transcript");
  }
  assert.equal(urls.some((url) => url.includes("evil.example")), false);
});

test("HTTP transcript via live adapter: success charges 1; failures charge 0", async () => {
  const fetchFn: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes(NO_CAPTION_ID)) {
      return textResponse(snippet("no_caption.html"));
    }
    if (url.includes(DELETED_ID)) {
      return textResponse(snippet("deleted.html"), 404);
    }
    if (url.includes("captioned.vtt")) {
      return textResponse(snippet("captioned.vtt"));
    }
    if (url.includes(VIDEO_ID)) {
      return textResponse(snippet("captioned.html"));
    }
    return textResponse(snippet("blocked.html"));
  };

  const db = openDatabase(":memory:");
  const key = createKey(db, { secret: KEY, credits: 10 });
  const app = await buildApp({
    db,
    adapter: createLiveTikTokAdapter({ fetch: fetchFn }),
  });
  after(async () => {
    await app.close();
    db.close();
  });
  const auth = { authorization: `Bearer ${KEY}` };

  const ok = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${VIDEO_ID}`,
    headers: auth,
  });
  assert.equal(ok.statusCode, 200);
  const okBody = ok.json() as OkBody;
  assert.ok(okBody.data.transcript.length >= 1);
  assert.equal(okBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 9);

  const none = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${NO_CAPTION_ID}`,
    headers: auth,
  });
  assert.equal(none.statusCode, 422);
  assert.equal((none.json() as ErrBody).error.code, "no_transcript");
  assert.equal((none.json() as ErrBody).meta.creditsCharged, 0);

  const gone = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${DELETED_ID}`,
    headers: auth,
  });
  assert.equal(gone.statusCode, 404);
  assert.equal((gone.json() as ErrBody).error.code, "not_found");
  assert.equal((gone.json() as ErrBody).meta.creditsCharged, 0);

  const blocked = await app.inject({
    method: "GET",
    url: "/v1/transcript?video_id=7011111111111111111",
    headers: auth,
  });
  assert.equal(blocked.statusCode, 503);
  assert.equal((blocked.json() as ErrBody).error.code, "upstream_blocked");
  assert.equal((blocked.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 9);
});
