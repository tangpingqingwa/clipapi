import type { FastifyPluginAsync } from "fastify";
import { getLatestVideos, listCreatorVideos } from "../../core/creators.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const CREATOR_LATEST_PATH = "/v1/creators/:handle/latest" as const;
export const CREATOR_VIDEOS_PATH = "/v1/creators/:handle/videos" as const;

type CreatorParams = {
  handle: string;
};

type CreatorQuerystring = {
  platform?: string;
  cursor?: string;
  limit?: string;
};

export const creatorRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: CreatorParams; Querystring: CreatorQuerystring }>(
    CREATOR_LATEST_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await getLatestVideos({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        query: {
          handle: request.params.handle,
          platform: request.query.platform,
        },
      });
      if ("error" in result) {
        return sendErr(
          reply,
          result.error.code,
          result.error.message,
          result.meta.requestId,
        );
      }
      return sendOk(reply, result.data, result.meta);
    },
  );

  app.get<{ Params: CreatorParams; Querystring: CreatorQuerystring }>(
    CREATOR_VIDEOS_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await listCreatorVideos({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        query: {
          handle: request.params.handle,
          platform: request.query.platform,
          cursor: request.query.cursor,
          limit: request.query.limit,
        },
      });
      if ("error" in result) {
        return sendErr(
          reply,
          result.error.code,
          result.error.message,
          result.meta.requestId,
        );
      }
      return sendOk(reply, result.data, result.meta);
    },
  );
};
