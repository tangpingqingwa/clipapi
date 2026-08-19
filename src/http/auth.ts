import type { FastifyReply, FastifyRequest } from "fastify";
import { lookupKey, type Key } from "../billing/keys.js";
import { sendErr } from "./envelope.js";

const BEARER = /^Bearer\s+(\S+)$/i;

export function readBearerSecret(header: string | undefined): string | null {
  if (header === undefined || header === "") {
    return null;
  }
  const match = BEARER.exec(header);
  return match?.[1] ?? null;
}

export function authenticateRequest(request: FastifyRequest): Key | null {
  const secret = readBearerSecret(request.headers.authorization);
  if (secret === null) {
    return null;
  }
  return lookupKey(request.server.db, secret);
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const key = authenticateRequest(request);
  if (key === null) {
    return sendErr(reply, "unauthorized", "Missing or invalid API key.");
  }
  request.apiKey = key;
}
