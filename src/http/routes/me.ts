import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const ME_PATH = "/v1/me" as const;

export type MeData = {
  key: { id: string; prefix: "ck_live" | "ck_test" };
  plan: string;
  creditsRemaining: number;
  rpm: number;
};

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get(ME_PATH, { preHandler: requireAuth }, async (request, reply) => {
    const key = request.apiKey;
    if (key === undefined) {
      return sendErr(reply, "internal", "Authenticated route missing key.");
    }
    const data: MeData = {
      key: { id: key.id, prefix: key.prefix },
      plan: key.plan,
      creditsRemaining: key.credits,
      rpm: key.rpm,
    };
    return sendOk(reply, data, {
      cached: false,
      creditsCharged: 0,
      upstreamMs: 0,
    });
  });
};
