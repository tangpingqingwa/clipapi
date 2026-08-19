import type { Key } from "../billing/keys.js";
import type { ClipApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: ClipApiDb;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
