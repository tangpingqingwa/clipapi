import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createFixtureAdapter } from "../src/adapters/tiktok/fixture.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { openDatabase } from "../src/db.js";
import {
  callMcpTool,
  GET_LATEST_VIDEOS_TOOL,
  GET_TRANSCRIPT_TOOL,
  LIST_CREATOR_VIDEOS_TOOL,
  MCP_TOOL_NAMES,
} from "../src/mcp/tools.js";
import { MCP_PATH, MCP_PROTOCOL_VERSION } from "../src/mcp/server.js";
import type { CreatorVideoPage, ErrorCode, Transcript } from "../src/types.js";

const KEY = "ck_test_mcp_fixture";
const CAPTIONED_ID = "7123456789012345678";
const HANDLE = "clipapi_fixture";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type OkBody<T> = {
  data: T;
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

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: OkBody<unknown> | ErrBody;
  isError: boolean;
};

type JsonRpcOk = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

async function appWithKey(credits = 100) {
  const db = openDatabase(":memory:");
  const key = createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: createFixtureAdapter(),
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

async function rpc(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: string,
  params?: unknown,
  headers: Record<string, string> = auth(),
) {
  return app.inject({
    method: "POST",
    url: MCP_PATH,
    headers,
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function callTool(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpc(app, "tools/call", { name, arguments: args });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as JsonRpcOk;
  const result = body.result as ToolResult;
  assert.ok(result);
  assert.equal(typeof result.isError, "boolean");
  return result;
}

test("GET /llms.txt is public and matches the checked-in file", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({ method: "GET", url: "/llms.txt" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/plain/);
  const onDisk = readFileSync(join(ROOT, "llms.txt"), "utf8");
  assert.equal(response.body, onDisk);
  assert.match(onDisk, /get_transcript/);
  assert.match(onDisk, /When not to call/i);
  assert.doesNotMatch(onDisk, /search_clips tool is available/i);
});

test("GET /.well-known/mcp/server-card.json lists shipped tools only", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: "/.well-known/mcp/server-card.json",
  });
  assert.equal(response.statusCode, 200);
  const card = response.json() as { tools: string[]; transport: string };
  assert.equal(card.transport, "streamable-http");
  const shipped = [...MCP_TOOL_NAMES];
  assert.deepEqual(card.tools, shipped);
  assert.ok(!card.tools.some((name) => name.includes("search")));
});

test("POST /mcp without bearer is 401 with 0 credits", async () => {
  const { app } = await appWithKey();
  const response = await rpc(app, "initialize", undefined, {});
  assert.equal(response.statusCode, 401);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("initialize and tools/list describe get_transcript, not search", async () => {
  const { app } = await appWithKey();

  const init = await rpc(app, "initialize");
  assert.equal(init.statusCode, 200);
  const initBody = init.json() as JsonRpcOk;
  const initResult = initBody.result as {
    protocolVersion: string;
    capabilities: { tools: unknown };
    serverInfo: { name: string };
  };
  assert.equal(initResult.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initResult.serverInfo.name, "clipapi");
  assert.ok(initResult.capabilities.tools);

  const listed = await rpc(app, "tools/list");
  assert.equal(listed.statusCode, 200);
  const tools = (
    (listed.json() as JsonRpcOk).result as {
      tools: Array<{ name: string }>;
    }
  ).tools.map((tool) => tool.name);
  assert.deepEqual(tools, [
    GET_TRANSCRIPT_TOOL,
    LIST_CREATOR_VIDEOS_TOOL,
    GET_LATEST_VIDEOS_TOOL,
  ]);
  assert.ok(!tools.some((name) => name.startsWith("search")));
});

test("SPEC 9: MCP get_transcript returns the same payload as REST", async () => {
  const { app, db, key } = await appWithKey(10);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/transcript?video_id=${CAPTIONED_ID}`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<Transcript>;
  assert.ok(restBody.data.transcript.length >= 1);
  assert.equal(restBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 9);

  const mcp = await callTool(app, GET_TRANSCRIPT_TOOL, {
    video_id: CAPTIONED_ID,
  });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<Transcript>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(mcpBody.meta.cached, true);
  assert.equal(mcpBody.meta.upstreamMs, 0);
  assert.match(mcpBody.meta.requestId, /^req_/);
  assert.equal(getCredits(db, key.id), 8);

  const parsedText = JSON.parse(mcp.content[0]?.text ?? "null") as OkBody<Transcript>;
  assert.deepEqual(parsedText.data, restBody.data);

  const inProcess = await callMcpTool({
    name: GET_TRANSCRIPT_TOOL,
    args: { video_id: CAPTIONED_ID },
    db,
    adapter: createFixtureAdapter(),
    key,
  });
  assert.equal("data" in inProcess, true);
  if ("data" in inProcess) {
    assert.deepEqual(inProcess.data, restBody.data);
    assert.equal(inProcess.meta.cached, true);
    assert.equal(inProcess.meta.creditsCharged, 1);
  }
  assert.equal(getCredits(db, key.id), 7);
});

test("MCP get_transcript url argument matches REST and still charges 1", async () => {
  const { app, db, key } = await appWithKey(4);
  const url = "https://www.tiktok.com/@clipapi_fixture/video/7123456789012345678";

  const mcp = await callTool(app, GET_TRANSCRIPT_TOOL, { url });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<Transcript>;
  assert.equal(mcpBody.data.videoId, CAPTIONED_ID);
  assert.ok(mcpBody.data.transcript.length >= 1);
  assert.equal(mcpBody.meta.creditsCharged, 1);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/transcript?url=${encodeURIComponent(url)}`,
    headers: auth(),
  });
  const restBody = rest.json() as OkBody<Transcript>;
  assert.deepEqual(restBody.data, mcpBody.data);
  assert.equal(getCredits(db, key.id), 2);
});

test("MCP get_transcript errors match REST: no_transcript, not_found, bad input, 402", async () => {
  const { app, db, key } = await appWithKey(3);

  const noCaption = await callTool(app, GET_TRANSCRIPT_TOOL, {
    video_id: "7987654321098765432",
  });
  assert.equal(noCaption.isError, true);
  const noCaptionBody = noCaption.structuredContent as ErrBody;
  assert.equal(noCaptionBody.error.code, "no_transcript");
  assert.equal(noCaptionBody.meta.creditsCharged, 0);

  const deleted = await callTool(app, GET_TRANSCRIPT_TOOL, {
    video_id: "7000000000000000001",
  });
  assert.equal((deleted.structuredContent as ErrBody).error.code, "not_found");
  assert.equal((deleted.structuredContent as ErrBody).meta.creditsCharged, 0);

  const missing = await callTool(app, GET_TRANSCRIPT_TOOL, {});
  assert.equal((missing.structuredContent as ErrBody).error.code, "invalid_request");

  const empty = await appWithKey(0);
  const unpaid = await callTool(empty.app, GET_TRANSCRIPT_TOOL, {
    video_id: CAPTIONED_ID,
  });
  assert.equal((unpaid.structuredContent as ErrBody).error.code, "payment_required");
  assert.equal((unpaid.structuredContent as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 3);
});

test("MCP creator tools call core: latest is free, videos charge 1 per page", async () => {
  const { app, db, key } = await appWithKey(6);

  const latest = await callTool(app, GET_LATEST_VIDEOS_TOOL, {
    handle: `@${HANDLE}`,
  });
  assert.equal(latest.isError, false);
  const latestBody = latest.structuredContent as OkBody<CreatorVideoPage>;
  assert.equal(latestBody.data.handle, HANDLE);
  assert.ok(latestBody.data.videos.length >= 1);
  assert.equal(latestBody.meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 6);

  const restLatest = await app.inject({
    method: "GET",
    url: `/v1/creators/${HANDLE}/latest`,
    headers: auth(),
  });
  assert.deepEqual(
    (restLatest.json() as OkBody<CreatorVideoPage>).data,
    latestBody.data,
  );

  const videos = await callTool(app, LIST_CREATOR_VIDEOS_TOOL, {
    handle: HANDLE,
    limit: 2,
  });
  assert.equal(videos.isError, false);
  const videosBody = videos.structuredContent as OkBody<CreatorVideoPage>;
  assert.equal(videosBody.data.videos.length, 2);
  assert.equal(videosBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 5);
});

test("unknown MCP tool and search_clips are invalid_request with 0 credits", async () => {
  const { app, db, key } = await appWithKey(5);
  for (const name of ["search_clips", "not_a_tool"]) {
    const result = await callTool(app, name, { q: "hello" });
    assert.equal(result.isError, true, name);
    const body = result.structuredContent as ErrBody;
    assert.equal(body.error.code, "invalid_request");
    assert.equal(body.meta.creditsCharged, 0);
  }
  assert.equal(getCredits(db, key.id), 5);
});
