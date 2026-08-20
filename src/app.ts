import Fastify, { type FastifyInstance } from "fastify";
import { createAppAdapter, type TranscriptAdapter } from "./adapters/index.js";
import { bootstrapKeyIfEmpty } from "./billing/keys.js";
import { createStripeClient, type StripePort } from "./billing/stripe.js";
import { parsePublicBaseUrl } from "./config.js";
import { openDatabase, type ClipApiDb } from "./db.js";
import { billingRoutes } from "./http/routes/billing.js";
import { creatorRoutes } from "./http/routes/creators.js";
import { healthRoutes } from "./http/routes/health.js";
import { meRoutes } from "./http/routes/me.js";
import { transcriptRoutes } from "./http/routes/transcript.js";
import { mcpRoutes } from "./mcp/server.js";

export type BuildAppOptions = {
  logger?: boolean;
  db?: ClipApiDb;
  databasePath?: string;
  bootstrapKey?: string;
  adapter?: TranscriptAdapter;
  stripe?: StripePort;
  stripeSecret?: string;
  webhookSecret?: string;
  publicBaseUrl?: string;
};

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  captureJsonRawBody(app);
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
  await app.register(creatorRoutes);
  await app.register(mcpRoutes);
  await app.register(billingRoutes, {
    stripe: options.stripe ?? createStripeClient({ secretKey: options.stripeSecret }),
    webhookSecret: options.webhookSecret,
    publicBaseUrl: options.publicBaseUrl ?? parsePublicBaseUrl(),
  });
  return app;
}

function captureJsonRawBody(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      const raw = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
      request.stripeRawBody = raw;
      if (raw === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw) as unknown);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
}
