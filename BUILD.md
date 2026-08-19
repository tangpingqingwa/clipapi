# ClipAPI — Detailed Specification and Build Plan

**Status:** Ready to implement  
**Product contract:** [SPEC.md](./SPEC.md) wins on API shape, credits, and errors.  
**This file** wins on stack, module boundaries, test layout, and the PR sequence.  
**Git:** [CONTRIBUTING.md](./CONTRIBUTING.md). Every row in the PR plan is one squash-merged PR. `main` stays green.

---

## 0. What we are building

A single Node process on one VPS that:

1. Issues API keys and meters credits.
2. Returns TikTok transcripts from a **swappable adapter** behind a frozen JSON envelope.
3. Speaks REST, OpenAPI, and MCP from the same handlers.
4. Never invents caption lines.
5. Never charges on failure.

TikTokToTranscript and DailyBrief are first-party clients. They must be able to run against a recorded fixture server before any live TikTok exists.

---

## 1. Locked stack (do not bikeshed in implementation PRs)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS | One runtime for APIs, SSR sites, SkillSeed |
| Language | TypeScript 5.x, `strict` | Envelope and OpenAPI stay typed |
| HTTP | Fastify 5 | Fast, schema validation, one process |
| Validation | Zod → Fastify JSON schema | Request/response fail closed |
| Persistence | SQLite via `better-sqlite3` | One file, backup = copy, no RDS in v1 |
| Cache bodies | SQLite `cache_entries` table (JSON text) | Same backup story |
| Auth | `Authorization: Bearer ck_live_…` / `ck_test_…` | SPEC |
| Billing (M2) | Stripe Checkout + webhook | Not in M0 |
| Tests | `node:test` + `tsx` | No Jest tax |
| Lint | `tsc --noEmit` in `scripts/test.sh` once `src/` exists |
| Process | `node --import tsx src/server.ts` in dev; `tsc` emit for prod |
| Host | One VPS, Caddy TLS. No AWS required for v1 |

**Out of stack:** Prisma, Nest, Redis, Kubernetes, Vercel, Supabase.

---

## 2. Process architecture

```
                    ┌─────────────┐
   HTTPS :443       │    Caddy    │
                    └──────┬──────┘
                           │ :3000
                    ┌──────▼──────┐
                    │  Fastify    │
                    │  app.ts     │
                    └──┬───┬───┬──┘
           REST /v1    │   │   │  /mcp  /openapi.json  /healthz
                       │   │   └─────────────┐
                       │   │                 │
                ┌──────▼┐ ┌▼────────┐  ┌─────▼─────┐
                │http/* │ │ billing │  │ mcp/server│
                └───┬───┘ └────┬────┘  └─────┬─────┘
                    │          │             │
                    └────┬─────┴─────────────┘
                         │
                   ┌─────▼─────┐
                   │  core/    │  getTranscript, search, listCreator
                   └─────┬─────┘
              ┌──────────┼──────────┐
              │          │          │
        ┌─────▼───┐ ┌────▼────┐ ┌───▼────┐
        │ cache   │ │ credits │ │adapter │
        │ (sqlite)│ │ (sqlite)│ │tiktok  │
        └─────────┘ └─────────┘ └───┬────┘
                                    │
                              live OR fixture
```

**Invariant:** HTTP and MCP call `core/*` only. They do not import `adapters/tiktok`.

---

## 3. Target tree

```
clipapi/
  README.md
  SPEC.md
  BUILD.md                 ← this file
  CONTRIBUTING.md
  package.json
  tsconfig.json
  openapi/openapi.yaml
  llms.txt
  scripts/test.sh
  src/
    server.ts              listen
    app.ts                 register plugins + routes
    config.ts              env, fail if CLIPAPI_DATABASE missing in prod
    types.ts               Envelope, Transcript, ErrorCode
    db.ts                  sqlite open + migrate
    migrate.ts             numbered SQL in src/migrations/
    migrations/
      001_init.sql
    http/
      auth.ts              bearer → Key
      envelope.ts          sendOk / sendErr
      routes/
        transcript.ts
        search.ts
        creators.ts
        me.ts
        health.ts
    core/
      transcript.ts
      search.ts
      creators.ts
    billing/
      credits.ts           charge only after success
      keys.ts              create/hash/lookup
    cache/
      store.ts             get/set/tombstone
    adapters/
      types.ts             TranscriptAdapter
      tiktok/
        index.ts           live (not called in unit tests)
        fixture.ts         recorded HTML/JSON → Transcript
    mcp/
      server.ts
      tools.ts
    testdoubles/
      memoryAdapter.ts
  tests/
    envelope.test.ts
    credits.test.ts
    transcript.test.ts
    fixtures/
      captioned.json
      no_caption.json
      deleted.json
```

---

## 4. Domain types (implementation-level)

```ts
export type Platform = "tiktok" | "reels" | "shorts";

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "payment_required"
  | "not_found"
  | "no_transcript"
  | "unsupported_platform"
  | "rate_limited"
  | "upstream_blocked"
  | "internal";

export type Cue = { text: string; start: number; duration: number | null };

export type Transcript = {
  platform: Platform;
  videoId: string;
  canonicalUrl: string;
  kind: "video" | "slideshow" | "unknown";
  language: string;
  durationMs: number | null;
  author: { handle: string | null; id: string | null };
  metadata: {
    description: string | null;
    createTime: string | null;
    musicTitle: string | null;
  };
  source: "platform_caption" | "platform_asr" | "on_screen";
  transcript: Cue[];
};

export type Ok<T> = {
  data: T;
  meta: { cached: boolean; creditsCharged: number; requestId: string; upstreamMs: number };
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};
```

HTTP map (must match SPEC):

| ErrorCode | HTTP |
|---|---|
| invalid_request | 400 |
| unauthorized | 401 |
| payment_required | 402 |
| not_found | 404 |
| no_transcript | 422 |
| unsupported_platform | 422 |
| rate_limited | 429 |
| upstream_blocked | 503 |
| internal | 500 |

`retryable` is true only for `rate_limited`, `upstream_blocked`, `internal`.

---

## 5. Core algorithms

### 5.1 `getTranscript({ url?, videoId?, platform?, lang? }, key)`

1. Parse. If neither `url` nor `videoId` → `invalid_request`.
2. Infer platform from host (`tiktok.com`, `vm.tiktok.com`). Unknown host → `unsupported_platform`.
3. Normalize `videoId` (digits only for TikTok).
4. Auth already ran. If key.creditsRemaining === 0 and plan is exhausted → `payment_required` **before** adapter (SPEC: do not work for free after empty).
5. Cache lookup `(platform, videoId, lang ?? "*")`.
   - Hit fresh → return, `cached: true`, **charge 1** (SPEC: success costs 1 even on cache).
   - Hit tombstone `not_found` within 24h → `not_found`, 0 credits.
6. Miss → adapter. Time the call → `upstreamMs`.
   - Adapter `ok` with `transcript.length === 0` → treat as `no_transcript` (never 200 empty array as success).
   - Adapter `ok` → write cache TTL 30d, charge 1, return `cached: false`.
   - Adapter `no_transcript` → do not cache as success; optional short negative cache 10 min; 0 credits.
   - Adapter `not_found` → tombstone 24h; 0 credits.
   - Adapter `blocked` → `upstream_blocked`; 0 credits; no tombstone.
7. Charge is a single SQLite transaction: insert `usage_events` + decrement `keys.credits`. If charge fails after adapter success, still return 200 and log (undercharge OK; overcharge forbidden). Prefer: charge in same transaction as writing a `request_id` idempotency row.

### 5.2 Credit transaction

```
BEGIN;
SELECT credits FROM keys WHERE id=?;
-- if 0: ROLLBACK; payment_required
INSERT usage_events(...);
UPDATE keys SET credits = credits - ? WHERE id=? AND credits >= ?;
-- if changes=0: ROLLBACK; payment_required
COMMIT;
```

Never decrement on error paths.

### 5.3 Test keys

`ck_test_*` always use the fixture adapter. 0 live network. Still 1 credit on success so dashboards work, but `CLIPAPI_TEST_KEYS_FREE=1` in CI can skip decrement.

---

## 6. SQLite schema (001_init.sql)

```sql
CREATE TABLE keys (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,          -- ck_live / ck_test
  hash TEXT NOT NULL UNIQUE,     -- sha256 of secret
  plan TEXT NOT NULL DEFAULT 'free',
  credits INTEGER NOT NULL,
  rpm INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  route TEXT NOT NULL,
  credits INTEGER NOT NULL,
  cached INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES keys(id)
);

CREATE TABLE cache_entries (
  cache_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- transcript | tombstone
  body TEXT,
  error_code TEXT,
  expires_at TEXT NOT NULL
);
```

---

## 7. Environment

| Name | Required | Default |
|---|---|---|
| `PORT` | no | 3000 |
| `CLIPAPI_DATABASE` | yes in prod | `./data/clipapi.sqlite` |
| `CLIPAPI_FIXTURE_ONLY` | no | `0`. `1` in CI — adapter is fixture |
| `CLIPAPI_BOOTSTRAP_KEY` | no | if set, insert this live key on empty DB (dev only) |
| `STRIPE_SECRET` | M2+ | |

`.env` is gitignored. Never read in unit tests.

---

## 8. OpenAPI and MCP

- `openapi/openapi.yaml` is hand-written and is the public contract. CI must `fail` if a Zod response does not satisfy the documented schema for fixture cases (write a small checker in `tests/openapi-contract.test.ts` by PR 3).
- MCP tools wrap `core/*` 1:1: `get_transcript`, `search_clips`, `list_creator_videos`, `get_latest_videos`.
- Auth: same bearer. No second key space.

---

## 9. Test plan (offline, required for main)

| File | Asserts |
|---|---|
| `envelope.test.ts` | HTTP codes, creditsCharged 0 on every error |
| `credits.test.ts` | success −1; 402 when 0; no decrement on 422/404/503 |
| `transcript.test.ts` | captioned fixture → ≥1 cue; no_caption → 422; deleted → 404; cache second call `cached: true` |
| `parse-url.test.ts` | vm.tiktok, www, video id only |
| `scripts/test.sh` | existing contract checks **plus** `npx tsc --noEmit` and `npx tsx --test tests/**/*.test.ts` once package.json exists |

Live TikTok is **not** in CI. Optional `tests/live/` gated on `CLIPAPI_LIVE=1`.

---

## 10. Performance budgets (measure after M1, enforce after M3)

- Cache hit p50 < 80ms on the same box, local SQLite, no Caddy.
- Miss is adapter-bound; we only budget our overhead < 20ms.

---

## 11. PR plan

Each PR is independently mergeable. Dependencies are hard.

### PR 1: Tooling skeleton

- **Description:** package.json, tsconfig, src/server.ts healthz, extend scripts/test.sh to compile + run tests (even if only health).
- **Files:** `package.json`, `tsconfig.json`, `src/server.ts`, `src/app.ts`, `src/http/routes/health.ts`, `scripts/test.sh`, `.gitignore`
- **Dependencies:** None
- **Acceptance:** `GET /healthz` 200 `{ ok: true }`. `scripts/test.sh` green.

### PR 2: Envelope, types, SQLite, keys

- **Description:** types.ts, db migrations, key create/lookup, sendOk/sendErr, `/v1/me`.
- **Files:** `src/types.ts`, `src/db.ts`, `src/migrations/001_init.sql`, `src/http/auth.ts`, `src/http/envelope.ts`, `src/http/routes/me.ts`, `src/billing/keys.ts`, `tests/envelope.test.ts`
- **Dependencies:** PR 1
- **Acceptance:** missing bearer → 401 0 credits. Bootstrap test key → `/v1/me` shows credits.

### PR 3: Transcript core + fixture adapter

- **Description:** implement 5.1 against fixture adapter only. Cache + credits.
- **Files:** `src/core/transcript.ts`, `src/cache/store.ts`, `src/billing/credits.ts`, `src/adapters/*`, `src/http/routes/transcript.ts`, `tests/transcript.test.ts`, `tests/credits.test.ts`, `tests/fixtures/*.json`, `openapi/openapi.yaml` (transcript + errors)
- **Dependencies:** PR 2
- **Acceptance:** SPEC acceptance rows 1–7 against fixtures.

### PR 4: latest + creator videos

- **Description:** `/v1/creators/:handle/latest` (0 credits) and `/videos` (1 / page) on fixtures.
- **Files:** `src/core/creators.ts`, `src/http/routes/creators.ts`, tests, OpenAPI
- **Dependencies:** PR 3
- **Acceptance:** SPEC row 8.

### PR 5: MCP + llms.txt

- **Description:** `/mcp` tools call core. `llms.txt` checked in.
- **Files:** `src/mcp/*`, `llms.txt`, `tests/mcp.test.ts`
- **Dependencies:** PR 4
- **Acceptance:** SPEC row 9 with in-process MCP client or HTTP tool invoke.

### PR 6: Search

- **Description:** `/v1/search` 1 credit / page, 0 if empty.
- **Files:** `src/core/search.ts`, route, tests
- **Dependencies:** PR 3 (can parallel PR 4/5 after 3; stack after 5)
- **Acceptance:** empty q → 400; fixture query → ≥1 hit charged 1.

### PR 7: Stripe monthly $5 (optional until first dollar)

- **Description:** Checkout + webhook add 1000 credits. Free 100 remains.
- **Files:** `src/billing/stripe.ts`, webhook route
- **Dependencies:** PR 2
- **Acceptance:** webhook fixture JSON increments credits. No live Stripe in CI.

**Launch to TikTokToTranscript:** after PR 5. Reels/Shorts are not in this plan.

---

## 12. Implementation notes for the TikTok adapter (PR 3 live path, later PR)

- Live adapter is a separate follow-up PR after fixture path is on `main`.
- It must implement `TranscriptAdapter` only.
- Failures map to the ErrorCode union — no raw exceptions across the core boundary.
- User-Agent + timeout 8s + one retry on 502/503 only.
- Parsing tests use checked-in HTML snippets, not live fetches.

---

## 13. Rollback

Any PR that makes `scripts/test.sh` red is reverted with `fix/` or `git revert` via PR. Do not force-push `main`.
