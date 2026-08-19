import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createFixtureAdapter } from "../src/adapters/tiktok/fixture.js";
import type {
  AdapterResult,
  CreatorListResult,
  TranscriptAdapter,
} from "../src/adapters/types.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { normalizeCreatorHandle } from "../src/core/creators.js";
import { openDatabase } from "../src/db.js";
import type { CreatorVideoPage, ErrorCode } from "../src/types.js";

const KEY = "ck_test_creators_fixture";
const HANDLE = "clipapi_fixture";

type OkBody = {
  data: CreatorVideoPage;
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

async function appWithKey(credits = 100, adapter?: TranscriptAdapter) {
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

test("normalizeCreatorHandle accepts @ and mixed case", () => {
  assert.equal(normalizeCreatorHandle("@ClipAPI_Fixture"), HANDLE);
  assert.equal(normalizeCreatorHandle("  clipapi_fixture  "), HANDLE);
  assert.equal(normalizeCreatorHandle("@"), null);
  assert.equal(normalizeCreatorHandle("bad handle"), null);
});

test("SPEC 8: latest is 200 with public uploads and 0 credits", async () => {
  const { app, db, key } = await appWithKey(7);

  const response = await app.inject({
    method: "GET",
    url: `/v1/creators/@${HANDLE}/latest`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.equal(body.data.handle, HANDLE);
  assert.equal(body.data.platform, "tiktok");
  assert.ok(body.data.videos.length >= 1);
  assert.ok(body.data.videos.length <= 15);
  assert.equal(body.data.nextCursor, null);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(body.meta.cached, false);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, key.id), 7);
  for (const video of body.data.videos) {
    assert.equal(typeof video.videoId, "string");
    assert.ok(video.videoId.length > 0);
    assert.equal(typeof video.url, "string");
    assert.match(video.url, /^https:\/\/www\.tiktok\.com\//);
  }
});

test("latest cache hit stays 0 credits and does not call the adapter again", async () => {
  let listCalls = 0;
  const inner = createFixtureAdapter();
  const counting: TranscriptAdapter = {
    resolveVideoId(ref) {
      return inner.resolveVideoId(ref);
    },
    fetchTranscript(request) {
      return inner.fetchTranscript(request);
    },
    async listCreatorVideos(request) {
      listCalls += 1;
      return inner.listCreatorVideos(request);
    },
  };
  const { app, db, key } = await appWithKey(5, counting);

  const first = await app.inject({
    method: "GET",
    url: `/v1/creators/${HANDLE}/latest`,
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as OkBody).meta.cached, false);
  assert.equal(listCalls, 1);

  const second = await app.inject({
    method: "GET",
    url: `/v1/creators/@${HANDLE}/latest`,
    headers: auth(),
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as OkBody;
  assert.equal(secondBody.meta.cached, true);
  assert.equal(secondBody.meta.creditsCharged, 0);
  assert.equal(secondBody.meta.upstreamMs, 0);
  assert.equal(listCalls, 1);
  assert.equal(getCredits(db, key.id), 5);
});

test("creator videos charges 1 per page including cache hits", async () => {
  const { app, db, key } = await appWithKey(10);

  const first = await app.inject({
    method: "GET",
    url: `/v1/creators/${HANDLE}/videos?limit=2`,
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as OkBody;
  assert.equal(firstBody.data.videos.length, 2);
  assert.equal(firstBody.data.nextCursor, "2");
  assert.equal(firstBody.meta.creditsCharged, 1);
  assert.equal(firstBody.meta.cached, false);
  assert.equal(getCredits(db, key.id), 9);

  const second = await app.inject({
    method: "GET",
    url: `/v1/creators/@${HANDLE}/videos?limit=2`,
    headers: auth(),
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as OkBody;
  assert.equal(secondBody.meta.cached, true);
  assert.equal(secondBody.meta.creditsCharged, 1);
  assert.deepEqual(secondBody.data.videos, firstBody.data.videos);
  assert.equal(getCredits(db, key.id), 8);

  const pageTwo = await app.inject({
    method: "GET",
    url: `/v1/creators/${HANDLE}/videos?limit=2&cursor=2`,
    headers: auth(),
  });
  assert.equal(pageTwo.statusCode, 200);
  const pageTwoBody = pageTwo.json() as OkBody;
  assert.equal(pageTwoBody.data.videos.length, 1);
  assert.equal(pageTwoBody.data.nextCursor, null);
  assert.equal(pageTwoBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 7);
});

test("unknown creator is 404 and 0 credits on both routes", async () => {
  const { app, db, key } = await appWithKey(4);

  for (const path of [
    "/v1/creators/missing_handle/latest",
    "/v1/creators/missing_handle/videos",
  ]) {
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: auth(),
    });
    assert.equal(response.statusCode, 404, path);
    const body = response.json() as ErrBody;
    assert.equal(body.error.code, "not_found");
    assert.equal(body.meta.creditsCharged, 0);
  }
  assert.equal(getCredits(db, key.id), 4);
});

test("empty key is 401; videos with 0 credits is 402; latest stays free", async () => {
  const { app, db, key } = await appWithKey(0);

  const unauth = await app.inject({
    method: "GET",
    url: `/v1/creators/${HANDLE}/latest`,
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as ErrBody).error.code, "unauthorized");
  assert.equal((unauth.json() as ErrBody).meta.creditsCharged, 0);

  const videos = await app.inject({
    method: "GET",
    url: `/v1/creators/${HANDLE}/videos`,
    headers: auth(),
  });
  assert.equal(videos.statusCode, 402);
  assert.equal((videos.json() as ErrBody).error.code, "payment_required");
  assert.equal((videos.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 0);

  const latest = await app.inject({
    method: "GET",
    url: `/v1/creators/${HANDLE}/latest`,
    headers: auth(),
  });
  assert.equal(latest.statusCode, 200);
  assert.equal((latest.json() as OkBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 0);
});

test("bad handle, limit, and cursor are 400 with 0 credits", async () => {
  const { app, db, key } = await appWithKey(3);
  const cases = [
    "/v1/creators/%20/latest",
    "/v1/creators/no%20space/videos",
    `/v1/creators/${HANDLE}/videos?limit=0`,
    `/v1/creators/${HANDLE}/videos?limit=21`,
    `/v1/creators/${HANDLE}/videos?cursor=bad%20token`,
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
  assert.equal(getCredits(db, key.id), 3);
});

test("HTTP creator routes do not import adapters/tiktok; adapter errors stay 0 credit", async () => {
  const blocked: TranscriptAdapter = {
    resolveVideoId(ref) {
      return ref;
    },
    async fetchTranscript(): Promise<AdapterResult> {
      return { ok: false, code: "upstream_blocked" };
    },
    async listCreatorVideos(): Promise<CreatorListResult> {
      return { ok: false, code: "upstream_blocked" };
    },
  };
  const { app, db, key } = await appWithKey(6, blocked);
  const response = await app.inject({
    method: "GET",
    url: `/v1/creators/${HANDLE}/videos`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 503);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "upstream_blocked");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 6);
});
