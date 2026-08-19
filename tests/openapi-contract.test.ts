import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createFixtureAdapter } from "../src/adapters/tiktok/fixture.js";
import { buildApp } from "../src/app.js";
import { createKey } from "../src/billing/keys.js";
import { openDatabase } from "../src/db.js";
import { ERROR_CODES, type ErrorCode, type Transcript } from "../src/types.js";

const OPENAPI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../openapi/openapi.yaml",
);

const KEY = "ck_test_openapi_fixture";
const CAPTIONED_ID = "7123456789012345678";
const NO_CAPTION_ID = "7987654321098765432";
const DELETED_ID = "7000000000000000001";

const HTTP_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  payment_required: 402,
  not_found: 404,
  no_transcript: 422,
  unsupported_platform: 422,
  rate_limited: 429,
  upstream_blocked: 503,
  internal: 500,
};

function loadOpenApi(): string {
  return readFileSync(OPENAPI_PATH, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertErrorEnvelope(body: unknown, code: ErrorCode): void {
  assert.ok(isRecord(body));
  assert.ok(isRecord(body.error));
  assert.ok(isRecord(body.meta));
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.equal(typeof body.error.retryable, "boolean");
  assert.equal(body.meta.creditsCharged, 0);
  assert.match(String(body.meta.requestId), /^req_/);
  assert.equal("data" in body, false);
}

function assertTranscriptEnvelope(body: unknown): Transcript {
  assert.ok(isRecord(body));
  assert.ok(isRecord(body.data));
  assert.ok(isRecord(body.meta));
  const data = body.data as Transcript;
  assert.equal(data.platform, "tiktok");
  assert.ok(Array.isArray(data.transcript));
  assert.ok(data.transcript.length >= 1);
  for (const cue of data.transcript) {
    assert.equal(typeof cue.text, "string");
    assert.ok(cue.text.length > 0);
    assert.equal(typeof cue.start, "number");
  }
  assert.equal(typeof body.meta.cached, "boolean");
  assert.equal(typeof body.meta.creditsCharged, "number");
  assert.match(String(body.meta.requestId), /^req_/);
  assert.equal(typeof body.meta.upstreamMs, "number");
  return data;
}

test("openapi.yaml documents transcript and every SPEC error code", () => {
  const spec = loadOpenApi();
  assert.match(spec, /\/v1\/transcript/);
  assert.match(spec, /operationId: getTranscript/);
  for (const code of ERROR_CODES) {
    assert.match(spec, new RegExp(`- ${code}`));
  }
  for (const status of Object.values(HTTP_BY_CODE)) {
    assert.match(spec, new RegExp(`"${status}"`));
  }
  assert.match(spec, /creditsCharged/);
  assert.match(spec, /no_transcript/);
  assert.match(spec, /Never invent|never invent/i);
});

test("fixture HTTP responses satisfy the documented envelope", async () => {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits: 10 });
  const app = await buildApp({ db, adapter: createFixtureAdapter() });
  after(async () => {
    await app.close();
    db.close();
  });
  const headers = { authorization: `Bearer ${KEY}` };

  const ok = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
    headers,
  });
  assert.equal(ok.statusCode, 200);
  assertTranscriptEnvelope(ok.json());

  const noCaption = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${NO_CAPTION_ID}`,
    headers,
  });
  assert.equal(noCaption.statusCode, 422);
  assertErrorEnvelope(noCaption.json(), "no_transcript");

  const deleted = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${DELETED_ID}`,
    headers,
  });
  assert.equal(deleted.statusCode, 404);
  assertErrorEnvelope(deleted.json(), "not_found");

  const bad = await app.inject({
    method: "GET",
    url: "/v1/transcript",
    headers,
  });
  assert.equal(bad.statusCode, 400);
  assertErrorEnvelope(bad.json(), "invalid_request");

  const unauth = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
  });
  assert.equal(unauth.statusCode, 401);
  assertErrorEnvelope(unauth.json(), "unauthorized");
});
