# ClipAPI — one-VPS runbook

Single Docker host. SQLite on a volume. The TikTok adapter stays on fixtures until you set `CLIPAPI_LIVE=1`. Stripe checkout stays fail-closed until a live `StripePort` exists; signed webhooks need `STRIPE_WEBHOOK_SECRET`.

## Env

Copy [`.env.example`](../.env.example) to `/etc/clipapi.env` (mode `600`). Set:

| Variable | Production |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | listen port (default `3000`) |
| `CLIPAPI_DATABASE` | required; must sit on the volume, e.g. `/app/data/clipapi.sqlite` |
| `PUBLIC_BASE_URL` | checkout success/cancel origin (default `http://localhost:3000`) |
| `CLIPAPI_BOOTSTRAP_KEY` | optional first `ck_live_...` when the keys table is empty |
| `CLIPAPI_LIVE` | leave unset (or `0`) until soak. `1` selects the live TikTok adapter |
| `CLIPAPI_FIXTURE_ONLY` | leave unset on the VPS. `1` wins over `CLIPAPI_LIVE` (CI / `scripts/test.sh`) |
| `STRIPE_SECRET` | leave commented. Reserved for a later live Stripe client |
| `STRIPE_WEBHOOK_SECRET` | HMAC for `POST /v1/billing/webhook`. Missing/invalid → 400 |

Do not bake secrets into the image. Do not commit `.env`. A bind-mount over `/app/data` must be writable by uid `1000` (`node`).

## Build and run

```bash
docker build -t clipapi:local .
docker run -d --name clipapi --restart unless-stopped --init \
  --env-file /etc/clipapi.env \
  -p 127.0.0.1:3000:3000 \
  -v clipapi-data:/app/data \
  clipapi:local
```

The process listens on `0.0.0.0:$PORT` as the non-root `node` user (uid 1000). Keep the published port on loopback and terminate TLS on Caddy or nginx.

## Health

`GET /healthz` → `200 {"ok":true}`. No auth.

```bash
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz"
```

After bootstrap:

```bash
curl -fsS -H "Authorization: Bearer $CLIPAPI_BOOTSTRAP_KEY" \
  "http://127.0.0.1:${PORT:-3000}/v1/me"
```

## Enable live TikTok

1. Confirm `/healthz` is green with live off (fixture adapter).
2. Set `CLIPAPI_LIVE=1`. `CLIPAPI_FIXTURE_ONLY=1` keeps fixtures even if live is set.
3. Recreate the container. Live fetches public TikTok HTML only (User-Agent + 8s timeout).
4. Captcha / ban / geo map to `upstream_blocked` (503, 0 credits). Never invent caption lines. `no_transcript` is 422, 0 credits.
5. Leave live flags unset in CI. `scripts/test.sh` sets `CLIPAPI_FIXTURE_ONLY=1` and unsets `CLIPAPI_LIVE`.

Roll back: unset `CLIPAPI_LIVE` (or set `CLIPAPI_FIXTURE_ONLY=1`) and recreate. Do not run live TikTok from CI.

## Enable Stripe

1. Confirm `/healthz` is green.
2. Set `STRIPE_WEBHOOK_SECRET` to the Stripe endpoint secret. Point Stripe at `POST /v1/billing/webhook` (no bearer; Stripe-signed).
3. Set `PUBLIC_BASE_URL` to the public origin used for checkout success/cancel.
4. Recreate the container. `checkout.session.completed` at $5 (500 cents) adds 1,000 credits; unused free 100 remains. `invoice.payment_failed` locks the key to free remaining = 0.
5. `POST /v1/billing/checkout` is bearer-auth and charges 0 credits. Without an injected live `StripePort` it fails closed (`500 internal`, 0 credits) and does not call Stripe — even if `STRIPE_SECRET` is set.
6. Leave `STRIPE_*` unset in CI. `scripts/test.sh` unsets them. Do not run live Stripe from this box until a live client exists.

Roll back: comment `STRIPE_*` and recreate. Webhook without a secret is 400.
