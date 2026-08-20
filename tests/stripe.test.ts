import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import {
  createKey,
  DEFAULT_FREE_CREDITS,
  DEFAULT_FREE_RPM,
} from "../src/billing/keys.js";
import {
  applyStripeEvent,
  createFixtureStripe,
  createStripeClient,
  MONTHLY_CREDITS,
  MONTHLY_PLAN,
  MONTHLY_PRICE_CENTS,
  MONTHLY_RPM,
  parseStripeWebhookEvent,
  signStripePayload,
} from "../src/billing/stripe.js";
import { openDatabase } from "../src/db.js";
import {
  CHECKOUT_PATH,
  WEBHOOK_PATH,
} from "../src/http/routes/billing.js";
import type { ErrorCode } from "../src/types.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/stripe",
);
const CHECKOUT_FIXTURE = readFileSync(
  join(FIXTURE_DIR, "checkout.session.completed.json"),
  "utf8",
);
const FAILED_FIXTURE = readFileSync(
  join(FIXTURE_DIR, "invoice.payment_failed.json"),
  "utf8",
);
const KEY_SECRET = "ck_test_stripe_fixture";
const KEY_ID = "key_stripe_fixture";
const WEBHOOK_SECRET = "whsec_test_fixture";

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number };
};

type CheckoutBody = {
  data: {
    url: string;
    sessionId: string;
    plan: string;
    amountCents: number;
    currency: string;
    credits: number;
  };
  meta: { creditsCharged: number; cached: boolean };
};

function auth() {
  return { authorization: `Bearer ${KEY_SECRET}` };
}

async function appWithStripe(options: {
  credits?: number;
  stripe?: ReturnType<typeof createFixtureStripe>;
  webhookSecret?: string;
}) {
  const db = openDatabase(":memory:");
  const key = createKey(db, {
    secret: KEY_SECRET,
    id: KEY_ID,
    credits: options.credits ?? DEFAULT_FREE_CREDITS,
  });
  const app = await buildApp({
    db,
    stripe: options.stripe,
    webhookSecret: options.webhookSecret ?? WEBHOOK_SECRET,
    publicBaseUrl: "http://clipapi.test",
  });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db, key };
}

test("monthly plan is $5 / 1000 credits; free grant stays 100", () => {
  assert.equal(MONTHLY_PRICE_CENTS, 500);
  assert.equal(MONTHLY_CREDITS, 1000);
  assert.equal(MONTHLY_RPM, 200);
  assert.equal(DEFAULT_FREE_CREDITS, 100);
  assert.equal(DEFAULT_FREE_RPM, 30);
});

test("createStripeClient never talks to Stripe and fails closed", async () => {
  const stripe = createStripeClient({ secretKey: "sk_test_should_not_matter" });
  await assert.rejects(
    stripe.createCheckoutSession({
      keyId: "key_x",
      successUrl: "http://x/ok",
      cancelUrl: "http://x/no",
    }),
    /live Stripe is not enabled/,
  );
});

test("wrong amount on checkout.session.completed does not add credits", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, { secret: KEY_SECRET, id: KEY_ID, credits: DEFAULT_FREE_CREDITS });
  const parsed = parseStripeWebhookEvent(JSON.parse(CHECKOUT_FIXTURE));
  assert.ok(parsed);
  assert.equal(parsed.type, "checkout.session.completed");
  if (parsed.type !== "checkout.session.completed") {
    return;
  }
  const applied = applyStripeEvent(db, { ...parsed, amountCents: 1 });
  assert.deepEqual(applied, { ok: false, error: "amount_mismatch" });
  assert.equal(getCredits(db, KEY_ID), DEFAULT_FREE_CREDITS);
});

test("webhook fixture JSON increments credits; free 100 remains", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  const key = createKey(db, {
    secret: KEY_SECRET,
    id: KEY_ID,
    credits: DEFAULT_FREE_CREDITS,
  });
  assert.equal(key.credits, 100);

  const parsed = parseStripeWebhookEvent(JSON.parse(CHECKOUT_FIXTURE));
  assert.ok(parsed);
  assert.equal(parsed.type, "checkout.session.completed");
  if (parsed.type !== "checkout.session.completed") {
    return;
  }
  assert.equal(parsed.amountCents, MONTHLY_PRICE_CENTS);
  assert.equal(parsed.keyId, KEY_ID);

  const applied = applyStripeEvent(db, parsed);
  assert.deepEqual(applied, {
    ok: true,
    keyId: KEY_ID,
    plan: MONTHLY_PLAN,
    creditsAdded: MONTHLY_CREDITS,
    creditsRemaining: DEFAULT_FREE_CREDITS + MONTHLY_CREDITS,
    replayed: false,
  });
  assert.equal(getCredits(db, KEY_ID), 1100);

  const replay = applyStripeEvent(db, parsed);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.replayed, true);
    assert.equal(replay.creditsAdded, 0);
    assert.equal(replay.creditsRemaining, 1100);
  }
  assert.equal(getCredits(db, KEY_ID), 1100);

  const row = db
    .prepare<
      [string],
      { plan: string; rpm: number; stripe_customer_id: string | null }
    >(
      "SELECT plan, rpm, stripe_customer_id FROM keys WHERE id = ?",
    )
    .get(KEY_ID);
  assert.equal(row?.plan, MONTHLY_PLAN);
  assert.equal(row?.rpm, MONTHLY_RPM);
  assert.equal(row?.stripe_customer_id, "cus_test_monthly");
});

test("invoice.payment_failed locks the key to free remaining 0", () => {
  const db = openDatabase(":memory:");
  after(() => db.close());
  createKey(db, {
    secret: KEY_SECRET,
    id: KEY_ID,
    credits: DEFAULT_FREE_CREDITS,
  });
  const checkout = parseStripeWebhookEvent(JSON.parse(CHECKOUT_FIXTURE));
  assert.ok(checkout);
  const paid = applyStripeEvent(db, checkout);
  assert.equal(paid.ok, true);

  const failed = parseStripeWebhookEvent(JSON.parse(FAILED_FIXTURE));
  assert.ok(failed);
  assert.equal(failed.type, "invoice.payment_failed");
  const applied = applyStripeEvent(db, failed);
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(applied.plan, "free");
    assert.equal(applied.creditsRemaining, 0);
    assert.equal(applied.replayed, false);
  }
  assert.equal(getCredits(db, KEY_ID), 0);
  const row = db
    .prepare<[string], { plan: string; rpm: number }>(
      "SELECT plan, rpm FROM keys WHERE id = ?",
    )
    .get(KEY_ID);
  assert.equal(row?.plan, "free");
  assert.equal(row?.rpm, DEFAULT_FREE_RPM);
});

test("POST /v1/billing/checkout is 0 credits and fail-closed without a StripePort", async () => {
  const { app, db, key } = await appWithStripe({});
  const unauth = await app.inject({ method: "POST", url: CHECKOUT_PATH });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as ErrBody).error.code, "unauthorized");
  assert.equal((unauth.json() as ErrBody).meta.creditsCharged, 0);

  const closed = await app.inject({
    method: "POST",
    url: CHECKOUT_PATH,
    headers: auth(),
  });
  assert.equal(closed.statusCode, 500);
  assert.equal((closed.json() as ErrBody).error.code, "internal");
  assert.equal((closed.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), DEFAULT_FREE_CREDITS);
});

test("fixture Stripe checkout + signed webhook fixture adds 1000 credits", async () => {
  const stripe = createFixtureStripe();
  const { app, db, key } = await appWithStripe({ stripe });

  const checkout = await app.inject({
    method: "POST",
    url: CHECKOUT_PATH,
    headers: auth(),
  });
  assert.equal(checkout.statusCode, 200);
  const body = checkout.json() as CheckoutBody;
  assert.equal(body.data.plan, MONTHLY_PLAN);
  assert.equal(body.data.amountCents, MONTHLY_PRICE_CENTS);
  assert.equal(body.data.currency, "usd");
  assert.equal(body.data.credits, MONTHLY_CREDITS);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(body.meta.cached, false);
  assert.match(body.data.url, /^https:\/\/billing\.clipapi\.test\/checkout\//);
  assert.equal(stripe.checkouts[0]?.keyId, key.id);
  assert.equal(getCredits(db, key.id), DEFAULT_FREE_CREDITS);

  const forged = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=deadbeef",
    },
    payload: CHECKOUT_FIXTURE,
  });
  assert.equal(forged.statusCode, 400);
  assert.deepEqual(forged.json(), { error: "invalid_signature" });
  assert.equal(getCredits(db, key.id), DEFAULT_FREE_CREDITS);

  const signature = signStripePayload(CHECKOUT_FIXTURE, WEBHOOK_SECRET);
  const hook = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    payload: CHECKOUT_FIXTURE,
  });
  assert.equal(hook.statusCode, 200);
  assert.deepEqual(hook.json(), {
    ok: true,
    plan: MONTHLY_PLAN,
    creditsAdded: MONTHLY_CREDITS,
    creditsRemaining: 1100,
    replayed: false,
  });
  assert.equal(getCredits(db, key.id), 1100);

  const replay = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    payload: CHECKOUT_FIXTURE,
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), {
    ok: true,
    plan: MONTHLY_PLAN,
    creditsAdded: 0,
    creditsRemaining: 1100,
    replayed: true,
  });
  assert.equal(getCredits(db, key.id), 1100);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: auth(),
  });
  assert.equal(me.statusCode, 200);
  const meBody = me.json() as {
    data: { plan: string; creditsRemaining: number; rpm: number };
    meta: { creditsCharged: number };
  };
  assert.equal(meBody.data.plan, MONTHLY_PLAN);
  assert.equal(meBody.data.creditsRemaining, 1100);
  assert.equal(meBody.data.rpm, MONTHLY_RPM);
  assert.equal(meBody.meta.creditsCharged, 0);
});

test("signed payment_failed webhook fixture zeros remaining credits", async () => {
  const { app, db, key } = await appWithStripe({});
  const paidSig = signStripePayload(CHECKOUT_FIXTURE, WEBHOOK_SECRET);
  const paid = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    headers: {
      "content-type": "application/json",
      "stripe-signature": paidSig,
    },
    payload: CHECKOUT_FIXTURE,
  });
  assert.equal(paid.statusCode, 200);
  assert.equal(getCredits(db, key.id), 1100);

  const failSig = signStripePayload(FAILED_FIXTURE, WEBHOOK_SECRET);
  const failed = await app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    headers: {
      "content-type": "application/json",
      "stripe-signature": failSig,
    },
    payload: FAILED_FIXTURE,
  });
  assert.equal(failed.statusCode, 200);
  assert.deepEqual(failed.json(), {
    ok: true,
    plan: "free",
    creditsAdded: 0,
    creditsRemaining: 0,
    replayed: false,
  });
  assert.equal(getCredits(db, key.id), 0);
});
