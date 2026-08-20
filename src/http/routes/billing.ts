import type { FastifyPluginAsync } from "fastify";
import {
  applyStripeEvent,
  MONTHLY_CREDITS,
  MONTHLY_PLAN,
  MONTHLY_PRICE_CENTS,
  parseStripeWebhookEvent,
  StripeUnavailableError,
  type StripePort,
  verifyStripeSignature,
} from "../../billing/stripe.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const CHECKOUT_PATH = "/v1/billing/checkout" as const;
export const WEBHOOK_PATH = "/v1/billing/webhook" as const;

export type BillingPluginOptions = {
  stripe: StripePort;
  webhookSecret?: string;
  publicBaseUrl: string;
};

export type CheckoutData = {
  url: string;
  sessionId: string;
  plan: typeof MONTHLY_PLAN;
  amountCents: number;
  currency: "usd";
  credits: number;
};

type WebhookErrorBody = { error: string };

export const billingRoutes: FastifyPluginAsync<BillingPluginOptions> = async (
  app,
  options,
) => {
  app.post(CHECKOUT_PATH, { preHandler: requireAuth }, async (request, reply) => {
    const key = request.apiKey;
    if (key === undefined) {
      return sendErr(reply, "internal", "Authenticated route missing key.");
    }
    try {
      const session = await options.stripe.createCheckoutSession({
        keyId: key.id,
        successUrl: `${options.publicBaseUrl}/v1/me?checkout=1`,
        cancelUrl: `${options.publicBaseUrl}/v1/me?checkout=canceled`,
      });
      const data: CheckoutData = {
        url: session.url,
        sessionId: session.id,
        plan: MONTHLY_PLAN,
        amountCents: MONTHLY_PRICE_CENTS,
        currency: "usd",
        credits: MONTHLY_CREDITS,
      };
      return sendOk(reply, data, {
        cached: false,
        creditsCharged: 0,
        upstreamMs: 0,
      });
    } catch (err) {
      if (err instanceof StripeUnavailableError) {
        return sendErr(reply, "internal", "Billing is not configured.");
      }
      throw err;
    }
  });

  app.post(WEBHOOK_PATH, async (request, reply) => {
    const rawBody = request.stripeRawBody;
    if (rawBody === undefined) {
      return reply.code(400).send({ error: "invalid_signature" } satisfies WebhookErrorBody);
    }
    const signature = headerValue(request.headers["stripe-signature"]);
    if (!verifyStripeSignature(rawBody, signature, options.webhookSecret)) {
      return reply.code(400).send({ error: "invalid_signature" } satisfies WebhookErrorBody);
    }
    const event = parseStripeWebhookEvent(request.body);
    if (event === null) {
      return reply.code(400).send({ error: "invalid_event" } satisfies WebhookErrorBody);
    }
    const applied = applyStripeEvent(request.server.db, event);
    if (!applied.ok) {
      return reply.code(400).send({ error: applied.error } satisfies WebhookErrorBody);
    }
    return {
      ok: true,
      plan: applied.plan,
      creditsAdded: applied.creditsAdded,
      creditsRemaining: applied.creditsRemaining,
      replayed: applied.replayed,
    };
  });
};

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
