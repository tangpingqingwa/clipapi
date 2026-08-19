import { randomUUID } from "node:crypto";
import { getLatestVideos, listCreatorVideos } from "../core/creators.js";
import {
  getTranscript,
  isRetryableCode,
  type GetTranscriptInput,
} from "../core/transcript.js";
import type { Err, ErrorCode, Ok } from "../types.js";

export const GET_TRANSCRIPT_TOOL = "get_transcript" as const;
export const LIST_CREATOR_VIDEOS_TOOL = "list_creator_videos" as const;
export const GET_LATEST_VIDEOS_TOOL = "get_latest_videos" as const;

export const MCP_TOOL_NAMES = [
  GET_TRANSCRIPT_TOOL,
  LIST_CREATOR_VIDEOS_TOOL,
  GET_LATEST_VIDEOS_TOOL,
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolOutcome = Ok<unknown> | Err;

export type CallMcpToolInput = {
  name: string;
  args: Record<string, unknown>;
  db: GetTranscriptInput["db"];
  adapter: GetTranscriptInput["adapter"];
  key: GetTranscriptInput["key"];
  requestId?: string;
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: GET_TRANSCRIPT_TOOL,
    description:
      "Timed transcript for a public short video. Maps to GET /v1/transcript. " +
      "1 credit on success, including cache hits. Failures charge 0. " +
      "Do not call for private videos, when you need the video file, or to post.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description: "Official TikTok share URL (one of url or video_id required)",
        },
        video_id: {
          type: "string",
          description: "Numeric TikTok video id (one of url or video_id required)",
        },
        platform: { type: "string", enum: ["tiktok", "reels", "shorts"] },
        lang: { type: "string", description: "BCP-47 language preference" },
        format: { type: "string", enum: ["json"] },
      },
    },
  },
  {
    name: LIST_CREATOR_VIDEOS_TOOL,
    description:
      "Paginated public uploads for a creator. Maps to GET /v1/creators/{handle}/videos. " +
      "1 credit per page. Handle may include a leading @.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["handle"],
      properties: {
        handle: {
          type: "string",
          description: "Public username, with or without @",
        },
        platform: { type: "string", enum: ["tiktok", "reels", "shorts"] },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: GET_LATEST_VIDEOS_TOOL,
    description:
      "Last ~15 public uploads for a creator. Maps to GET /v1/creators/{handle}/latest. " +
      "0 credits. Do not expect freshness under 60 seconds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["handle"],
      properties: {
        handle: {
          type: "string",
          description: "Public username, with or without @",
        },
        platform: { type: "string", enum: ["tiktok", "reels", "shorts"] },
      },
    },
  },
];

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatch an MCP tool to core/* only. */
export async function callMcpTool(
  input: CallMcpToolInput,
): Promise<McpToolOutcome> {
  if (!isMcpToolName(input.name)) {
    return fail(
      "invalid_request",
      input.requestId,
      `Unknown MCP tool '${input.name}'.`,
    );
  }

  switch (input.name) {
    case GET_TRANSCRIPT_TOOL:
      return getTranscript({
        db: input.db,
        adapter: input.adapter,
        key: input.key,
        requestId: input.requestId,
        query: {
          url: readStringArg(input.args, "url"),
          videoId: readStringArg(input.args, "video_id", "videoId"),
          platform: readStringArg(input.args, "platform"),
          lang: readStringArg(input.args, "lang"),
          format: readStringArg(input.args, "format"),
        },
      });
    case LIST_CREATOR_VIDEOS_TOOL:
      return listCreatorVideos({
        db: input.db,
        adapter: input.adapter,
        key: input.key,
        requestId: input.requestId,
        query: {
          handle: readStringArg(input.args, "handle") ?? "",
          platform: readStringArg(input.args, "platform"),
          cursor: readStringArg(input.args, "cursor"),
          limit: readLimitArg(input.args),
        },
      });
    case GET_LATEST_VIDEOS_TOOL:
      return getLatestVideos({
        db: input.db,
        adapter: input.adapter,
        key: input.key,
        requestId: input.requestId,
        query: {
          handle: readStringArg(input.args, "handle") ?? "",
          platform: readStringArg(input.args, "platform"),
        },
      });
  }
}

function fail(code: ErrorCode, requestId: string | undefined, message: string): Err {
  return {
    error: {
      code,
      message,
      retryable: isRetryableCode(code),
    },
    meta: { creditsCharged: 0, requestId: requestId ?? `req_${randomUUID()}` },
  };
}

function readStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function readLimitArg(args: Record<string, unknown>): string | undefined {
  const value = args.limit;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return undefined;
}
