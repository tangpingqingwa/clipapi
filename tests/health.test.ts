import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { HEALTHZ_PATH } from "../src/http/routes/health.js";

test("GET /healthz returns 200 { ok: true }", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({ method: "GET", url: HEALTHZ_PATH });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
});
