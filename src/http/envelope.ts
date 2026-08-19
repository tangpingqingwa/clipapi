import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { Err, ErrorCode, Ok } from "../types.js";

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  payment_required: 402,
  not_found: 404,
  no_transcript: 422,
  unsupported_platform: 422,
  rate_limited: 429,
  upstream_blocked: 503,
  internal: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "rate_limited",
  "upstream_blocked",
  "internal",
]);

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId = newRequestId(),
): Err {
  return {
    error: { code, message, retryable: isRetryable(code) },
    meta: { creditsCharged: 0, requestId },
  };
}

export function sendOk<T>(
  reply: FastifyReply,
  data: T,
  meta: {
    cached: boolean;
    creditsCharged: number;
    upstreamMs: number;
    requestId?: string;
  },
): FastifyReply {
  const body: Ok<T> = {
    data,
    meta: {
      cached: meta.cached,
      creditsCharged: meta.creditsCharged,
      requestId: meta.requestId ?? newRequestId(),
      upstreamMs: meta.upstreamMs,
    },
  };
  return reply.status(200).send(body);
}

export function sendErr(
  reply: FastifyReply,
  code: ErrorCode,
  message: string,
  requestId?: string,
): FastifyReply {
  return reply
    .status(httpStatusFor(code))
    .send(errorEnvelope(code, message, requestId ?? newRequestId()));
}
