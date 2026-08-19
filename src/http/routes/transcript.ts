import type { FastifyPluginAsync } from "fastify";
import { getTranscript } from "../../core/transcript.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const TRANSCRIPT_PATH = "/v1/transcript" as const;

type TranscriptQuerystring = {
  url?: string;
  video_id?: string;
  platform?: string;
  lang?: string;
  format?: string;
};

export const transcriptRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: TranscriptQuerystring }>(
    TRANSCRIPT_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await getTranscript({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        query: {
          url: request.query.url,
          videoId: request.query.video_id,
          platform: request.query.platform,
          lang: request.query.lang,
          format: request.query.format,
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
