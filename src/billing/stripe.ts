import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ClipApiDb } from "../db.js";
import { DEFAULT_FREE_RPM } from "./keys.js";

export const MONTHLY_PLAN = "monthly" as const;
export const FREE_PLAN = "free" as const;
export const MONTHLY_PRICE_CENTS = 500;
export const MONTHLY_CREDITS = 1000;
export const MONTHLY_RPM = 200;
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

export type PaidPlan = typeof MONTHLY_PLAN;

export type CheckoutSession = {
  id: string;
  url: string;
  keyId: string;
  plan: PaidPlan;
  amountCents: number;
  currency: "usd";
};

export type CreateCheckoutArgs = {
  keyId: string;
  successUrl: string;
  cancelUrl: string;
};

export type StripePort = {
  createCheckoutSession(args: CreateCheckoutArgs): Promise<CheckoutSession>;
};

export class StripeUnavailableError extends Error {
  readonly code = "billing_unavailable" as const;

  constructor(message = "live Stripe is not enabled; inject StripePort") {
    super(message);
    this.name = "StripeUnavailableError";
  }
}

export type CheckoutCompletedEvent = {
  type: "checkout.session.completed";
  id: string;
  keyId: string;
  plan: PaidPlan;
  amountCents: number;
  customerId: string | null;
  subscriptionId: string | null;
  sessionId: string;
};

export type PaymentFailedEvent = {
  type: "invoice.payment_failed";
  id: string;
  keyId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
};

export type StripeWebhookEvent = CheckoutCompletedEvent | PaymentFailedEvent;

export type ApplyStripeResult =
  | {
      ok: true;
      keyId: string;
      plan: string;
      creditsAdded: number;
      creditsRemaining: number;
      replayed: boolean;
    }
  | {
      ok: false;
      error: "missing_key" | "amount_mismatch" | "invalid_plan";
    };

type KeyBillingRow = {
  id: string;
  plan: string;
  credits: number;
  rpm: number;
};

export type StripeClientConfig = {
  secretKey?: string;
  webhookSecret?: string;
};

/** Fail-closed adapter. Tests inject `createFixtureStripe()`. Never calls Stripe. */
export function createStripeClient(_config: StripeClientConfig = {}): StripePort {
  return {
    async createCheckoutSession(): Promise<CheckoutSession> {
      throw new StripeUnavailableError();
    },
  };
}

export function createFixtureStripe(): StripePort & { checkouts: CheckoutSession[] } {
  const checkouts: CheckoutSession[] = [];
  return {
    checkouts,
    async createCheckoutSession(args: CreateCheckoutArgs): Promise<CheckoutSession> {
      const id = `cs_test_${randomBytes(8).toString("hex")}`;
      const session: CheckoutSession = {
        id,
        url: `https://billing.clipapi.test/checkout/${id}`,
        keyId: args.keyId,
        plan: MONTHLY_PLAN,
        amountCents: MONTHLY_PRICE_CENTS,
        currency: "usd",
      };
      checkouts.push(session);
      return session;
    },
  };
}

export function signStripePayload(
  rawBody: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (secret === undefined || secret === "" || header === undefined || header === "") {
    return false;
  }
  const parsed = parseStripeSignatureHeader(header);
  if (parsed === null) {
    return false;
  }
  const ageSec = Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp);
  if (ageSec > STRIPE_SIGNATURE_TOLERANCE_SEC) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return timingSafeEqualHex(parsed.v1, expected);
}

export function parseStripeWebhookEvent(value: unknown): StripeWebhookEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asNonEmptyString(value.id);
  const type = asNonEmptyString(value.type);
  if (id === null || type === null) {
    return null;
  }
  const object = eventObject(value);
  if (object === null) {
    return null;
  }
  if (type === "checkout.session.completed") {
    const keyId =
      asNonEmptyString(object.client_reference_id) ??
      metadataString(object, "keyId");
    const amountCents = asInteger(object.amount_total);
    const plan = parsePaidPlan(
      metadataString(object, "plan") ?? MONTHLY_PLAN,
    );
    const sessionId = asNonEmptyString(object.id);
    if (keyId === null || amountCents === null || plan === null || sessionId === null) {
      return null;
    }
    return {
      type,
      id,
      keyId,
      plan,
      amountCents,
      customerId: asOptionalId(object.customer),
      subscriptionId: asOptionalId(object.subscription),
      sessionId,
    };
  }
  if (type === "invoice.payment_failed") {
    return {
      type,
      id,
      keyId: metadataString(object, "keyId"),
      customerId: asOptionalId(object.customer),
      subscriptionId: asOptionalId(object.subscription),
    };
  }
  return null;
}

export function applyStripeEvent(
  db: ClipApiDb,
  event: StripeWebhookEvent,
  now = new Date(),
): ApplyStripeResult {
  if (event.type === "checkout.session.completed") {
    return applyCheckoutCompleted(db, event, now);
  }
  return applyPaymentFailed(db, event, now);
}

function applyCheckoutCompleted(
  db: ClipApiDb,
  event: CheckoutCompletedEvent,
  now: Date,
): ApplyStripeResult {
  if (event.plan !== MONTHLY_PLAN) {
    return { ok: false, error: "invalid_plan" };
  }
  if (event.amountCents !== MONTHLY_PRICE_CENTS) {
    return { ok: false, error: "amount_mismatch" };
  }
  return db.transaction((): ApplyStripeResult => {
    const replayed = alreadyApplied(db, event.id);
    if (replayed) {
      return snapshotResult(db, event.keyId, 0, true) ?? { ok: false, error: "missing_key" };
    }
    const row = loadKey(db, event.keyId);
    if (row === null) {
      return { ok: false, error: "missing_key" };
    }
    db.prepare(
      `UPDATE keys
          SET credits = credits + ?,
              plan = ?,
              rpm = ?,
              stripe_customer_id = COALESCE(?, stripe_customer_id),
              stripe_subscription_id = COALESCE(?, stripe_subscription_id)
        WHERE id = ?`,
    ).run(
      MONTHLY_CREDITS,
      MONTHLY_PLAN,
      MONTHLY_RPM,
      event.customerId,
      event.subscriptionId,
      event.keyId,
    );
    recordEvent(db, event.id, event.type, event.keyId, now);
    return snapshotResult(db, event.keyId, MONTHLY_CREDITS, false) ?? {
      ok: false,
      error: "missing_key",
    };
  })();
}

function applyPaymentFailed(
  db: ClipApiDb,
  event: PaymentFailedEvent,
  now: Date,
): ApplyStripeResult {
  return db.transaction((): ApplyStripeResult => {
    const keyId = resolveFailedKeyId(db, event);
    if (keyId === null) {
      return { ok: false, error: "missing_key" };
    }
    if (alreadyApplied(db, event.id)) {
      return snapshotResult(db, keyId, 0, true) ?? { ok: false, error: "missing_key" };
    }
    db.prepare(
      `UPDATE keys
          SET credits = 0,
              plan = ?,
              rpm = ?
        WHERE id = ?`,
    ).run(FREE_PLAN, DEFAULT_FREE_RPM, keyId);
    recordEvent(db, event.id, event.type, keyId, now);
    return snapshotResult(db, keyId, 0, false) ?? { ok: false, error: "missing_key" };
  })();
}

function resolveFailedKeyId(db: ClipApiDb, event: PaymentFailedEvent): string | null {
  if (event.keyId !== null && loadKey(db, event.keyId) !== null) {
    return event.keyId;
  }
  if (event.subscriptionId !== null) {
    const bySub = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM keys WHERE stripe_subscription_id = ?",
      )
      .get(event.subscriptionId);
    if (bySub !== undefined) {
      return bySub.id;
    }
  }
  if (event.customerId !== null) {
    const byCustomer = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM keys WHERE stripe_customer_id = ?",
      )
      .get(event.customerId);
    if (byCustomer !== undefined) {
      return byCustomer.id;
    }
  }
  return null;
}

function alreadyApplied(db: ClipApiDb, eventId: string): boolean {
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM stripe_events WHERE id = ?")
    .get(eventId);
  return row !== undefined;
}

function loadKey(db: ClipApiDb, keyId: string): KeyBillingRow | null {
  const row = db
    .prepare<[string], KeyBillingRow>(
      "SELECT id, plan, credits, rpm FROM keys WHERE id = ?",
    )
    .get(keyId);
  return row === undefined ? null : row;
}

function snapshotResult(
  db: ClipApiDb,
  keyId: string,
  creditsAdded: number,
  replayed: boolean,
): ApplyStripeResult | null {
  const row = loadKey(db, keyId);
  if (row === null) {
    return null;
  }
  return {
    ok: true,
    keyId,
    plan: row.plan,
    creditsAdded,
    creditsRemaining: row.credits,
    replayed,
  };
}

function recordEvent(
  db: ClipApiDb,
  id: string,
  type: string,
  keyId: string,
  now: Date,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO stripe_events (id, type, key_id, applied_at) VALUES (?, ?, ?, ?)",
  ).run(id, type, keyId, now.toISOString());
}

function parseStripeSignatureHeader(
  header: string,
): { timestamp: number; v1: string } | null {
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (name === "t") {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) {
        timestamp = parsed;
      }
    } else if (name === "v1" && value !== "") {
      v1 = value;
    }
  }
  if (timestamp === null || v1 === null) {
    return null;
  }
  return { timestamp, v1 };
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function eventObject(value: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(value.data) && isRecord(value.data.object)) {
    return value.data.object;
  }
  return null;
}

function metadataString(
  object: Record<string, unknown>,
  key: string,
): string | null {
  if (!isRecord(object.metadata)) {
    return null;
  }
  return asNonEmptyString(object.metadata[key]);
}

function parsePaidPlan(value: string): PaidPlan | null {
  return value === MONTHLY_PLAN ? MONTHLY_PLAN : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asOptionalId(value: unknown): string | null {
  return asNonEmptyString(value);
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
