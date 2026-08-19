import Fastify, { type FastifyInstance } from "fastify";
import { createAppAdapter, type TranscriptAdapter } from "./adapters/index.js";
import { bootstrapKeyIfEmpty } from "./billing/keys.js";
import { openDatabase, type ClipApiDb } from "./db.js";
import { healthRoutes } from "./http/routes/health.js";
import { meRoutes } from "./http/routes/me.js";
import { transcriptRoutes } from "./http/routes/transcript.js";

export type BuildAppOptions = {
  logger?: boolean;
  db?: ClipApiDb;
  databasePath?: string;
  bootstrapKey?: string;
  adapter?: TranscriptAdapter;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase(options.databasePath ?? ":memory:");
  if (options.bootstrapKey !== undefined) {
    bootstrapKeyIfEmpty(db, options.bootstrapKey);
  }
  app.decorate("db", db);
  app.decorate("adapter", options.adapter ?? createAppAdapter());
  app.decorateRequest("apiKey", undefined);
  if (ownsDb) {
    app.addHook("onClose", async (instance) => {
      instance.db.close();
    });
  }
  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(transcriptRoutes);
  return app;
}
