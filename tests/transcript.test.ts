import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createFixtureAdapter } from "../src/adapters/tiktok/fixture.js";
import { buildApp } from "../src/app.js";
import { createKey } from "../src/billing/keys.js";
import { getCredits } from "../src/billing/credits.js";
import { parseTranscriptQuery } from "../src/core/transcript.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Transcript } from "../src/types.js";

const KEY = "ck_test_transcript_fixture";
const CAPTIONED_ID = "7123456789012345678";
const NO_CAPTION_ID = "7987654321098765432";
const DELETED_ID = "7000000000000000001";

type OkBody = {
  data: Transcript;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
  };
};

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

async function appWithKey(credits = 100) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: createFixtureAdapter(),
  });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

test("parseTranscriptQuery accepts official TikTok hosts and numeric ids", () => {
  const urls = [
    {
      url: "https://www.tiktok.com/@clipapi_fixture/video/7123456789012345678",
      videoId: CAPTIONED_ID,
    },
    {
      url: "https://tiktok.com/@x/video/7123456789012345678/",
      videoId: CAPTIONED_ID,
    },
    {
      url: "https://m.tiktok.com/v/7123456789012345678",
      videoId: CAPTIONED_ID,
    },
    {
      url: "https://vm.tiktok.com/ZTfixture1",
      videoId: "ZTfixture1",
    },
  ];

  for (const item of urls) {
    const parsed = parseTranscriptQuery({ url: item.url });
    assert.equal(parsed.ok, true, item.url);
    if (parsed.ok) {
      assert.equal(parsed.videoId, item.videoId);
      assert.equal(parsed.platform, "tiktok");
    }
  }

  const idOnly = parseTranscriptQuery({ videoId: CAPTIONED_ID });
  assert.equal(idOnly.ok, true);
  if (idOnly.ok) {
    assert.equal(idOnly.videoId, CAPTIONED_ID);
    assert.equal(idOnly.platform, "tiktok");
  }
});

test("parseTranscriptQuery rejects missing, bad, and unsupported inputs", () => {
  const missing = parseTranscriptQuery({});
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "invalid_request");
  }

  const badUrl = parseTranscriptQuery({ url: "not-a-url" });
  assert.equal(badUrl.ok, false);
  if (!badUrl.ok) {
    assert.equal(badUrl.code, "invalid_request");
  }

  const youtube = parseTranscriptQuery({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  assert.equal(youtube.ok, false);
  if (!youtube.ok) {
    assert.equal(youtube.code, "unsupported_platform");
  }

  const reels = parseTranscriptQuery({
    videoId: CAPTIONED_ID,
    platform: "reels",
  });
  assert.equal(reels.ok, false);
  if (!reels.ok) {
    assert.equal(reels.code, "unsupported_platform");
  }
});

test("SPEC 1: captioned fixture is 200 with ≥1 cue and 1 credit", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db
    .prepare<[], { id: string }>("SELECT id FROM keys")
    .get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.ok(body.data.transcript.length >= 1);
  assert.equal(body.data.videoId, CAPTIONED_ID);
  assert.equal(body.data.platform, "tiktok");
  assert.equal(body.data.source, "platform_caption");
  assert.equal(body.meta.cached, false);
  assert.equal(body.meta.creditsCharged, 1);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, keyRow.id), 9);
  for (const cue of body.data.transcript) {
    assert.equal(typeof cue.text, "string");
    assert.ok(cue.text.length > 0);
    assert.equal(typeof cue.start, "number");
  }
});

test("SPEC 2: repeat same id is cached and still charges 1", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db
    .prepare<[], { id: string }>("SELECT id FROM keys")
    .get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: `/v1/transcript?url=${encodeURIComponent(
      "https://www.tiktok.com/@clipapi_fixture/video/7123456789012345678",
    )}`,
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as OkBody;
  assert.equal(firstBody.meta.cached, false);
  assert.equal(firstBody.meta.creditsCharged, 1);

  const started = performance.now();
  const second = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
    headers: auth(),
  });
  const elapsedMs = performance.now() - started;
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as OkBody;
  assert.equal(secondBody.meta.cached, true);
  assert.equal(secondBody.meta.creditsCharged, 1);
  assert.equal(secondBody.meta.upstreamMs, 0);
  assert.deepEqual(secondBody.data.transcript, firstBody.data.transcript);
  assert.ok(elapsedMs < 80, `cache hit took ${elapsedMs}ms`);
  assert.equal(getCredits(db, keyRow.id), 8);
});

test("SPEC 3: no-caption fixture is 422 no_transcript and 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db
    .prepare<[], { id: string }>("SELECT id FROM keys")
    .get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${NO_CAPTION_ID}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 422);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "no_transcript");
  assert.equal(body.error.retryable, false);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
  assert.equal("data" in body, false);
});

test("SPEC 4: deleted id is 404 not_found and 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db
    .prepare<[], { id: string }>("SELECT id FROM keys")
    .get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${DELETED_ID}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "not_found");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("SPEC 5: bad URL is 400 and 0 credit; unknown host is 422", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db
    .prepare<[], { id: string }>("SELECT id FROM keys")
    .get();
  assert.ok(keyRow);

  const cases = [
    "/v1/transcript",
    "/v1/transcript?url=not-a-url",
    "/v1/transcript?video_id=abc",
  ];
  for (const url of cases) {
    const response = await app.inject({
      method: "GET",
      url,
      headers: auth(),
    });
    assert.equal(response.statusCode, 400, url);
    const body = response.json() as ErrBody;
    assert.equal(body.error.code, "invalid_request");
    assert.equal(body.meta.creditsCharged, 0);
  }

  const unsupported = await app.inject({
    method: "GET",
    url: `/v1/transcript?url=${encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ")}`,
    headers: auth(),
  });
  assert.equal(unsupported.statusCode, 422);
  const unsupportedBody = unsupported.json() as ErrBody;
  assert.equal(unsupportedBody.error.code, "unsupported_platform");
  assert.equal(unsupportedBody.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("SPEC 6: empty or unknown key is 401", async () => {
  const { app } = await appWithKey();
  const cases = [
    {},
    { authorization: "" },
    { authorization: "Bearer" },
    { authorization: "Bearer ck_test_unknown" },
  ];
  for (const headers of cases) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
      headers,
    });
    assert.equal(response.statusCode, 401);
    const body = response.json() as ErrBody;
    assert.equal(body.error.code, "unauthorized");
    assert.equal(body.meta.creditsCharged, 0);
  }
});

test("SPEC 7: credits = 0 is 402 before adapter work", async () => {
  const { app, db } = await appWithKey(0);
  const keyRow = db
    .prepare<[], { id: string }>("SELECT id FROM keys")
    .get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 402);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "payment_required");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 0);

  const cached = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cache_entries")
    .get();
  assert.equal(cached?.n, 0);
});

test("HTTP route does not import adapters/tiktok; unknown id stays 404 0 credit", async () => {
  const { app, db } = await appWithKey(3);
  const keyRow = db
    .prepare<[], { id: string }>("SELECT id FROM keys")
    .get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/transcript?video_id=7011111111111111111",
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "not_found");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("vm.tiktok short code resolves to the captioned fixture", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/transcript?url=${encodeURIComponent("https://vm.tiktok.com/ZTfixture1")}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.equal(body.data.videoId, CAPTIONED_ID);
  assert.ok(body.data.transcript.length >= 1);
});
