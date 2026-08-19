import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createFixtureAdapter } from "../src/adapters/tiktok/fixture.js";
import type { AdapterRequest, AdapterResult, TranscriptAdapter } from "../src/adapters/types.js";
import { buildApp } from "../src/app.js";
import { chargeCredits, getCredits, TRANSCRIPT_CREDIT_COST } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode } from "../src/types.js";

const KEY = "ck_test_credits_fixture";
const CAPTIONED_ID = "7123456789012345678";
const NO_CAPTION_ID = "7987654321098765432";
const DELETED_ID = "7000000000000000001";

type ErrBody = {
  error: { code: ErrorCode };
  meta: { creditsCharged: number };
};

async function appWith(credits: number, adapter?: TranscriptAdapter) {
  const db = openDatabase(":memory:");
  const key = createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: adapter ?? createFixtureAdapter(),
  });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db, key };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

test("chargeCredits decrements only when the key has enough credits", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const key = createKey(db, { secret: "ck_live_charge_unit", credits: 2 });

  const first = chargeCredits(db, {
    keyId: key.id,
    route: "/v1/transcript",
    credits: TRANSCRIPT_CREDIT_COST,
    cached: false,
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.charged, 1);
    assert.equal(first.remaining, 1);
  }
  assert.equal(getCredits(db, key.id), 1);

  const second = chargeCredits(db, {
    keyId: key.id,
    route: "/v1/transcript",
    credits: 2,
    cached: false,
  });
  assert.deepEqual(second, { ok: false, code: "payment_required" });
  assert.equal(getCredits(db, key.id), 1);

  const usage = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM usage_events")
    .get();
  assert.equal(usage?.n, 1);
});

test("success charges 1; 422/404/503 never decrement", async () => {
  const blocked: TranscriptAdapter = {
    resolveVideoId(ref) {
      return ref;
    },
    async fetchTranscript(): Promise<AdapterResult> {
      return { ok: false, code: "upstream_blocked" };
    },
    async listCreatorVideos() {
      return { ok: false, code: "upstream_blocked" };
    },
  };

  const { app, db, key } = await appWith(10);
  const blockedApp = await buildApp({
    db,
    adapter: blocked,
  });
  after(() => blockedApp.close());

  const ok = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
    headers: auth(),
  });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { meta: { creditsCharged: number } }).meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 9);

  const noCaption = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${NO_CAPTION_ID}`,
    headers: auth(),
  });
  assert.equal(noCaption.statusCode, 422);
  assert.equal((noCaption.json() as ErrBody).meta.creditsCharged, 0);

  const deleted = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${DELETED_ID}`,
    headers: auth(),
  });
  assert.equal(deleted.statusCode, 404);
  assert.equal((deleted.json() as ErrBody).meta.creditsCharged, 0);

  const blockedRes = await blockedApp.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}99`,
    headers: auth(),
  });
  assert.equal(blockedRes.statusCode, 503);
  assert.equal((blockedRes.json() as ErrBody).error.code, "upstream_blocked");
  assert.equal((blockedRes.json() as ErrBody).meta.creditsCharged, 0);

  assert.equal(getCredits(db, key.id), 9);
  const usage = db
    .prepare<[], { credits: number }>("SELECT credits FROM usage_events")
    .all();
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.credits, 1);
});

test("empty caption array from adapter is no_transcript and is not charged", async () => {
  const empty: TranscriptAdapter = {
    resolveVideoId(ref) {
      return ref;
    },
    async listCreatorVideos() {
      return { ok: false, code: "not_found" };
    },
    async fetchTranscript(request: AdapterRequest): Promise<AdapterResult> {
      return {
        ok: true,
        transcript: {
          platform: request.platform,
          videoId: request.videoId,
          canonicalUrl: `https://www.tiktok.com/@x/video/${request.videoId}`,
          kind: "video",
          language: "en",
          durationMs: 1000,
          author: { handle: "x", id: "1" },
          metadata: { description: null, createTime: null, musicTitle: null },
          source: "platform_caption",
          transcript: [],
        },
      };
    },
  };
  const { app, db, key } = await appWith(4, empty);
  const response = await app.inject({
    method: "GET",
    url: "/v1/transcript?video_id=7111111111111111111",
    headers: auth(),
  });
  assert.equal(response.statusCode, 422);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "no_transcript");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 4);
});

test("402 when credits are already 0 does not write usage", async () => {
  const { app, db, key } = await appWith(0);
  const response = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 0);
  const usage = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM usage_events")
    .get();
  assert.equal(usage?.n, 0);
});
