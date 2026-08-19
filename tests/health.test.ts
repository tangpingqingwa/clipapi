import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";

test("GET /healthz returns 200 { ok: true }", async () => {
  const app = await buildApp();
  after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
});
