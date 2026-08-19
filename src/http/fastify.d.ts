import type { TranscriptAdapter } from "../adapters/types.js";
import type { Key } from "../billing/keys.js";
import type { ClipApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: ClipApiDb;
    adapter: TranscriptAdapter;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
