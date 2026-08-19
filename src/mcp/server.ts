import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../http/auth.js";
import { newRequestId } from "../http/envelope.js";
import {
  callMcpTool,
  MCP_TOOLS,
  type McpToolOutcome,
} from "./tools.js";

export const MCP_PATH = "/mcp" as const;
export const LLMS_TXT_PATH = "/llms.txt" as const;
export const MCP_SERVER_CARD_PATH = "/.well-known/mcp/server-card.json" as const;

export const MCP_PROTOCOL_VERSION = "2025-03-26" as const;

const LLMS_TXT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../llms.txt"),
  "utf8",
);

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

const SERVER_CARD = {
  name: "clipapi",
  description:
    "Timed transcripts and public creator uploads for short video. Bearer auth.",
  url: "https://mcp.clipapi.dev/mcp",
  transport: "streamable-http",
  authentication: { type: "bearer" },
  tools: MCP_TOOLS.map((tool) => tool.name),
};

export const mcpRoutes: FastifyPluginAsync = async (app) => {
  app.get(LLMS_TXT_PATH, async (_request, reply) => {
    return reply
      .type("text/plain; charset=utf-8")
      .status(200)
      .send(LLMS_TXT);
  });

  app.get(MCP_SERVER_CARD_PATH, async (_request, reply) => {
    return reply.status(200).send(SERVER_CARD);
  });

  app.post(MCP_PATH, { preHandler: requireAuth }, async (request, reply) => {
    const rpc = parseJsonRpc(request.body);
    if (!rpc.ok) {
      return sendRpc(reply, rpc.error);
    }

    if (rpc.request.id === undefined) {
      return reply.status(202).send();
    }

    const result = await dispatch(request, {
      ...rpc.request,
      id: rpc.request.id,
    });
    return sendRpc(reply, result);
  });
};

async function dispatch(
  request: FastifyRequest,
  rpc: JsonRpcRequest & { id: JsonRpcId },
): Promise<JsonRpcSuccess | JsonRpcError> {
  switch (rpc.method) {
    case "initialize":
      return ok(rpc.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "clipapi", version: "0.1.0" },
        instructions:
          "Read /llms.txt. Do not call for private videos, media downloads, or posting.",
      });
    case "ping":
      return ok(rpc.id, {});
    case "tools/list":
      return ok(rpc.id, { tools: MCP_TOOLS });
    case "tools/call":
      return callTool(request, rpc);
    default:
      return rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}

async function callTool(
  request: FastifyRequest,
  rpc: JsonRpcRequest & { id: JsonRpcId },
): Promise<JsonRpcSuccess | JsonRpcError> {
  const key = request.apiKey;
  if (key === undefined) {
    return rpcError(rpc.id, -32603, "Authenticated route missing key.");
  }
  const parsed = parseToolCall(rpc.params);
  if (!parsed.ok) {
    return rpcError(rpc.id, -32602, parsed.message);
  }

  const outcome = await callMcpTool({
    name: parsed.name,
    args: parsed.args,
    db: request.server.db,
    adapter: request.server.adapter,
    key,
    requestId: newRequestId(),
  });
  return ok(rpc.id, toolResult(outcome));
}

function toolResult(outcome: McpToolOutcome): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: McpToolOutcome;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(outcome) }],
    structuredContent: outcome,
    isError: "error" in outcome,
  };
}

function parseToolCall(
  params: unknown,
):
  | { ok: true; name: string; args: Record<string, unknown> }
  | { ok: false; message: string } {
  if (!isRecord(params) || typeof params.name !== "string" || params.name === "") {
    return { ok: false, message: "tools/call requires params.name." };
  }
  if (params.arguments === undefined) {
    return { ok: true, name: params.name, args: {} };
  }
  if (!isRecord(params.arguments)) {
    return { ok: false, message: "tools/call arguments must be an object." };
  }
  return { ok: true, name: params.name, args: params.arguments };
}

function parseJsonRpc(
  body: unknown,
):
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; error: JsonRpcError } {
  if (Array.isArray(body)) {
    return {
      ok: false,
      error: rpcError(null, -32600, "JSON-RPC batches are not supported."),
    };
  }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return {
      ok: false,
      error: rpcError(readId(body), -32600, "Invalid JSON-RPC request."),
    };
  }
  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      id: "id" in body ? readId(body) : undefined,
      method: body.method,
      params: body.params,
    },
  };
}

function readId(body: unknown): JsonRpcId {
  if (!isRecord(body)) {
    return null;
  }
  const id = body.id;
  if (typeof id === "string" || typeof id === "number" || id === null) {
    return id;
  }
  return null;
}

function ok(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendRpc(
  reply: FastifyReply,
  body: JsonRpcSuccess | JsonRpcError,
): FastifyReply {
  return reply.status(200).send(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
