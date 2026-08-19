import Fastify, { type FastifyInstance } from "fastify";
import { bootstrapKeyIfEmpty } from "./billing/keys.js";
import { openDatabase, type ClipApiDb } from "./db.js";
import { healthRoutes } from "./http/routes/health.js";
import { meRoutes } from "./http/routes/me.js";

export type BuildAppOptions = {
  logger?: boolean;
  db?: ClipApiDb;
  databasePath?: string;
  bootstrapKey?: string;
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
  if (ownsDb) {
    app.addHook("onClose", (instance, done) => {
      instance.db.close();
      done();
    });
  }
  await app.register(healthRoutes);
  await app.register(meRoutes);
  return app;
}
