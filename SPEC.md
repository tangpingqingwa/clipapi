# ClipAPI — Product Development Spec

**Version:** 1.0  
**Status:** Ready to build  
**Repo:** https://github.com/tangpingqingwa/clipapi  
**First-party clients:** TikTokToTranscript, DailyBrief, SkillSeed  
**Platforms in v1:** TikTok only in production; Reels / Shorts behind `preview` until CI stays green for 7 days

This is TranscriptAPI for short video. Sell a stable contract, not a caption toy.

---

## 1. Product statement

REST + MCP that turns a public short-video URL into timed transcript JSON, and lists a creator’s public uploads.

Buyers already pay $5–49/mo for YouTube transcripts. They cannot get the same for TikTok without fighting blocks.

One-line pitch: **Stop fighting TikTok blocks. One credit, one JSON transcript.**

---

## 2. Goals and non-goals

### Goals

- `GET /v1/transcript` p50 < 80ms on cache hit; p95 < 8s on miss when upstream is healthy.
- Failed / empty / blocked calls cost **0 credits**.
- Same envelope for every platform we later add.
- Signup today: 100 free credits, no card.
- MCP + OpenAPI + `llms.txt` on day one.
- TikTokToTranscript 100% of its traffic through this API.

### Non-goals

- Hosting MP4 / no-watermark downloads.
- Posting, DMs, live, shop.
- Default LLM summaries on the hot path.
- Advertising Reels/Shorts before they pass the 7-day soak.
- Matching TikTok Research API’s firehose.

---

## 3. Auth

```
Authorization: Bearer ck_live_...
Authorization: Bearer ck_test_...   # deterministic fixtures, 0 credits always
```

Keys created at `/dashboard` after email magic link **or** GitHub OAuth (pick one for v1; magic link is enough).

Scopes: none in v1. All keys can call all read endpoints. Abuse = revoke.

Rate limits (paid $5 plan): 200 rpm default, burst 50. Free: 30 rpm.

---

## 4. Common envelope

Success:

```json
{
  "data": {},
  "meta": {
    "cached": true,
    "creditsCharged": 1,
    "requestId": "req_...",
    "upstreamMs": 12
  }
}
```

Error (HTTP 4xx/5xx, **creditsCharged = 0**):

```json
{
  "error": {
    "code": "no_transcript",
    "message": "This video has no public caption track.",
    "retryable": false
  },
  "meta": { "creditsCharged": 0, "requestId": "req_..." }
}
```

### Error codes

| code | HTTP | retryable | meaning |
|---|---|---|---|
| `invalid_request` | 400 | no | bad URL / missing param |
| `unauthorized` | 401 | no | bad key |
| `payment_required` | 402 | no | out of credits |
| `not_found` | 404 | no | video deleted or private |
| `no_transcript` | 422 | no | public video, no caption/ASR track |
| `unsupported_platform` | 422 | no | URL we do not claim |
| `rate_limited` | 429 | yes | RPM |
| `upstream_blocked` | 503 | yes | captcha / ban / geo |
| `internal` | 500 | yes | our bug |

Never invent transcript lines on `no_transcript`.

---

## 5. Endpoints

Base: `https://api.clipapi.dev` (placeholder). Version prefix `/v1`.

### 5.1 `GET /v1/transcript`

**Credits:** 1 on success.

Query:

| name | required | notes |
|---|---|---|
| `url` | one of url/id | any official TikTok share URL |
| `video_id` | one of url/id | numeric id |
| `platform` | no | default inferred; `tiktok` \| `reels` \| `shorts` |
| `lang` | no | BCP-47 preference |
| `format` | no | `json` (default) |

`data`:

```ts
{
  platform: "tiktok" | "reels" | "shorts"
  videoId: string
  canonicalUrl: string
  kind: "video" | "slideshow" | "unknown"
  language: string
  durationMs: number | null
  author: { handle: string | null, id: string | null }
  metadata: {
    description: string | null
    createTime: string | null
    musicTitle: string | null
  }
  source: "platform_caption" | "platform_asr" | "on_screen"
  transcript: Array<{ text: string, start: number, duration: number | null }>
  // start is seconds float, TranscriptAPI-compatible
}
```

`start` / `duration` use **seconds**, not ms, so agents copy-paste against existing YouTube transcript code.

### 5.2 `GET /v1/search`

**Credits:** 1 per page returned (success with ≥1 hit). Empty page: 0 credits.

Query: `q`, `platform` (default `tiktok`), `cursor`, `limit` (1–20, default 10).

`data.results[]`: `videoId`, `title/description`, `author`, `lengthText`, `hasCaptions` (bool or null), `url`.

### 5.3 `GET /v1/creators/{handle}/videos`

**Credits:** 1 per page.

Paginated public uploads. `handle` with or without `@`.

### 5.4 `GET /v1/creators/{handle}/latest`

**Credits:** 0.

Last ~15 public uploads. For DailyBrief / monitors. Cache 5–15 min. Do not promise <60s freshness.

### 5.5 Control plane (0 credits)

- `GET /v1/me` — key, plan, credits remaining, rpm
- `GET /v1/usage?from&to` — daily buckets
- `POST /v1/billing/checkout` — Stripe Checkout session for the monthly $5 / 1,000-credit plan (bearer). Live Stripe is optional; without secrets the handler fails closed and does not call Stripe.
- `POST /v1/billing/webhook` — Stripe-signed events. `checkout.session.completed` at $5 adds 1,000 credits (the unused free 100 remains). `invoice.payment_failed` locks the key to free remaining = 0. Not bearer-auth.
- `GET /healthz`

---

## 6. Billing

| Plan | Price | Credits / mo | Top-up |
|---|---|---|---|
| Free | $0 | 100 once, 90-day expiry | none |
| Monthly | $5 | 1,000 | $2.50 / 1k |
| Annual | $54 ($4.50/mo) | 1,000 / mo | $1.50 / 1k |

Unused subscription credits do not roll. Top-ups last ≥30 days or until period end, whichever later. Need an active paid plan to spend top-ups (same as TranscriptAPI).

Internal keys for TikTokToTranscript / DailyBrief: unlimited or high pool, still metered for cost.

Stripe for checkout. Failed charges lock the key to free remaining = 0.

---

## 7. Caching and cost

| Resource | Key | TTL |
|---|---|---|
| Transcript | `(platform, videoId, lang)` | 30 days or until `not_found` |
| Creator list | `(platform, handle, cursor)` | 15 min |
| Latest | `(platform, handle)` | 10 min |
| Search | `(platform, q, cursor)` | 5 min |

On `not_found`, tombstone 24h so we do not hammer deleted ids.

One VPS until ~100k req/day. No AWS required. If AWS: one box + optional SQS for later Reels workers.

Upstream adapter lives in `/internal/tiktok`. It is **not** a public module. Fixtures in CI, no live TikTok in unit tests.

---

## 8. MCP / agents

Hosted MCP: `https://mcp.clipapi.dev` (Streamable HTTP). OAuth or `Authorization: Bearer`.

Tools (≤5 in v1):

| tool | maps to |
|---|---|
| `get_transcript` | `/v1/transcript` |
| `search_clips` | `/v1/search` |
| `list_creator_videos` | `/v1/creators/{handle}/videos` |
| `get_latest_videos` | `/v1/creators/{handle}/latest` |

`SKILL.md` generated/maintained via SkillSeed. Must include **when not to call** (private videos, need video file, need to post).

Ship `/.well-known/mcp/server-card.json`, `/openapi.json`, `/llms.txt`.

Week-one distribution: Cursor deeplink, Claude MCP docs, OpenClaw skill directory, ChatGPT connector doc. Being first matters more than a fourth endpoint.

---

## 9. Dashboard / docs site

- Marketing: problem, curl, pricing, MCP install.
- Docs: OpenAPI rendered + recipes (n8n, LangChain, agent dialogue).
- Dashboard: create key, usage chart, billing portal.

Comparison blog (required for SEO): vs unofficial scrapers; vs TikTok Research API application.

Legal: independent, not affiliated. Customer ToS: read-only public content; no circumvention of private videos; no using us to build a TikTok clone.

---

## 10. SLOs

| Metric | Target |
|---|---|
| Availability | 99.5% monthly (v1), 99.9% after M3 |
| Cache-hit transcript p50 | < 80ms |
| Miss p95 (healthy upstream) | < 8s |
| Credit accuracy | 0 overcharges; undercharge OK |
| Poison / invented lines | 0 known incidents |

Status page public (even a static `/status`).

---

## 11. Acceptance tests

| # | Case | Expected |
|---|---|---|
| 1 | Known captioned fixture | 200, ≥1 cue, 1 credit |
| 2 | Repeat same id | `cached: true`, p50 < 80ms, 1 credit |
| 3 | No-caption fixture | 422 `no_transcript`, 0 credit |
| 4 | Deleted id | 404 `not_found`, 0 credit |
| 5 | Bad URL | 400, 0 credit |
| 6 | Empty key | 401 |
| 7 | Credits = 0 | 402 |
| 8 | `latest` | 200, 0 credit |
| 9 | MCP `get_transcript` | same payload as REST |
| 10 | TikTokToTranscript can render from this payload | contract test in CI |

Load: 100 rps cached transcripts for 5 min, error rate < 0.1%.

---

## 12. Milestones

**M0:** envelope, keys, credits table, healthz, OpenAPI stub.  
**M1:** TikTok transcript + cache + errors 3–5.  
**M2:** latest + creator videos; Stripe $5 plan; dashboard key.  
**M3:** MCP + llms.txt + SkillSeed pack; TikTokToTranscript cutover.  
**M4:** search.  
**M5:** Reels or Shorts in `preview` only.

Launch = M3.

---

## 13. Suggested layout

```
/
  SPEC.md
  README.md
  openapi/openapi.yaml
  src/
    http/
    billing/
    adapters/tiktok/
    mcp/
  tests/fixtures/
```

Adapters must be swappable without changing the public schema. Schema bump = `/v2`.

## 14. Git collaboration (normative)

Development is GitHub trunk-based. **`main` is always cloneable, buildable, and testable.**

| Rule | Requirement |
|---|---|
| Integration branch | `main` only. No long-lived `develop`. |
| How code lands | Pull request into `main`. No direct push. |
| Required check | GitHub Actions workflow `ci` (job id `ci`) must be green. |
| Local / CI test | `bash scripts/test.sh` — offline, no production secrets. |
| Branch names | `feat/` `fix/` `docs/` `chore/` `test/` + short slug. |
| Merge | Squash. Delete the head branch. |
| Broken `main` | Treat as an incident. Fix on `fix/…` via PR. |

Full process: [CONTRIBUTING.md](./CONTRIBUTING.md).

Implementation plan (stack, modules, PR DAG): [BUILD.md](./BUILD.md).

Until there is an application binary, `scripts/test.sh` still has to pass: contract files exist, SPEC/CONTRIBUTING agree, no tracked secrets. Adding a server or CLI means **extending** that script with unit/contract tests. Live upstream calls are optional and must not be required for `main` to stay green.
