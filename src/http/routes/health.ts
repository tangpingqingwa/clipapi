import type { FastifyPluginAsync } from "fastify";

export const HEALTHZ_PATH = "/healthz" as const;

export type HealthzOk = {
  ok: true;
};

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(HEALTHZ_PATH, async (): Promise<HealthzOk> => ({ ok: true }));
};
