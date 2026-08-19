import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./http/routes/health.js";

export type BuildAppOptions = {
  logger?: boolean;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  await app.register(healthRoutes);
  return app;
}
