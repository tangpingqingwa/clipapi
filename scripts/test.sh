#!/usr/bin/env bash
# Offline gate for main. Must exit 0 on a clean clone with no secrets.
# Contract checks stay; once package.json exists we also typecheck and run
# node:test. Do not require live third-party networks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== contract files =="
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh llms.txt; do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done

echo "== contributing rules are documented =="
grep -q 'main must always be buildable' CONTRIBUTING.md \
  || grep -q 'main` must always be buildable' CONTRIBUTING.md \
  || fail "CONTRIBUTING.md does not state the main-branch rule"

echo "== SPEC mentions git collaboration =="
grep -q 'Git collaboration' SPEC.md || fail "SPEC.md missing Git collaboration section"

echo "== no committed secrets =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env$|(^|/)id_rsa$|\.pem$|credentials\.json$' >/dev/null; then
    fail "secret-like path is tracked"
  fi
fi

echo "== markdown is UTF-8 text =="
file -b --mime-encoding README.md SPEC.md CONTRIBUTING.md llms.txt | grep -qiE 'utf-8|us-ascii' \
  || fail "docs are not UTF-8/ASCII"

echo "== transcript fixtures and OpenAPI =="
for f in \
  openapi/openapi.yaml \
  tests/fixtures/captioned.json \
  tests/fixtures/no_caption.json \
  tests/fixtures/deleted.json \
  tests/fixtures/creators/clipapi_fixture.json \
  tests/fixtures/html/captioned.html \
  tests/fixtures/html/no_caption.html \
  tests/fixtures/html/live_stripped.html \
  tests/fixtures/html/deleted.html \
  tests/fixtures/html/blocked.html \
  tests/fixtures/html/captioned.vtt \
  tests/fixtures/stripe/checkout.session.completed.json \
  tests/fixtures/stripe/invoice.payment_failed.json
do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done
grep -q '/v1/transcript' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/transcript"
grep -q '/v1/creators/{handle}/latest' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/creators/{handle}/latest"
grep -q '/v1/creators/{handle}/videos' openapi/openapi.yaml \
  || fail "openapi.yaml missing GET /v1/creators/{handle}/videos"
grep -q '/v1/billing/checkout' openapi/openapi.yaml \
  || fail "openapi.yaml missing POST /v1/billing/checkout"
grep -q '/v1/billing/webhook' openapi/openapi.yaml \
  || fail "openapi.yaml missing POST /v1/billing/webhook"
grep -q 'no_transcript' openapi/openapi.yaml \
  || fail "openapi.yaml missing no_transcript"

echo "== llms.txt + MCP tools =="
[[ -f src/mcp/server.ts ]] || fail "missing src/mcp/server.ts"
[[ -f src/mcp/tools.ts ]] || fail "missing src/mcp/tools.ts"
[[ -f tests/mcp.test.ts ]] || fail "missing tests/mcp.test.ts"
grep -q 'get_transcript' llms.txt || fail "llms.txt missing get_transcript"
grep -q 'When not to call' llms.txt || fail "llms.txt missing when-not-to-call"
if grep -q 'search_clips' src/mcp/tools.ts; then
  fail "src/mcp/tools.ts must not ship search (PR 6)"
fi
if grep -R --include='*.ts' -E "from ['\"]stripe['\"]|STRIPE_" src/mcp >/dev/null 2>&1; then
  fail "src/mcp must not import Stripe (PR 7)"
fi

echo "== stripe monthly checkout is offline =="
[[ -f src/billing/stripe.ts ]] || fail "missing src/billing/stripe.ts"
[[ -f src/http/routes/billing.ts ]] || fail "missing src/http/routes/billing.ts"
[[ -f src/migrations/002_stripe.sql ]] || fail "missing src/migrations/002_stripe.sql"
[[ -f tests/stripe.test.ts ]] || fail "missing tests/stripe.test.ts"
grep -q 'MONTHLY_PRICE_CENTS' src/billing/stripe.ts \
  || fail "src/billing/stripe.ts missing monthly $5 price"
grep -q 'MONTHLY_CREDITS' src/billing/stripe.ts \
  || fail "src/billing/stripe.ts missing 1000 monthly credits"
grep -q 'checkout.session.completed' tests/stripe.test.ts \
  || fail "stripe tests must apply checkout.session.completed fixture"
grep -q 'createFixtureStripe\|createStripeClient' tests/stripe.test.ts \
  || fail "stripe tests must use the fail-closed / fixture client"
if grep -E '"stripe"' package.json package-lock.json >/dev/null 2>&1; then
  fail "do not add the live stripe SDK (CI stays offline)"
fi
if grep -R --include='*.ts' -E "from ['\"]stripe['\"]" src tests >/dev/null 2>&1; then
  fail "must not import the stripe package"
fi
if grep -R --include='*.ts' -E 'https?://api\.stripe\.com|https?://checkout\.stripe\.com' src/billing src/http/routes/billing.ts >/dev/null 2>&1; then
  fail "billing must not call live Stripe hosts"
fi
if grep -Eqi 'STRIPE_(SECRET|SECRET_KEY|API_KEY|WEBHOOK_SECRET)=' .github/workflows/ci.yml; then
  fail "CI must not set live Stripe secrets"
fi
if grep -R --include='*.ts' -E 'fetch\s*\(|https?://www\.tiktok\.com/api/' src/mcp >/dev/null 2>&1; then
  fail "src/mcp must not call live TikTok"
fi

echo "== live TikTok adapter is env-gated and offline-tested =="
[[ -f src/adapters/tiktok/parse.ts ]] || fail "missing src/adapters/tiktok/parse.ts"
[[ -f tests/tiktok-parse.test.ts ]] || fail "missing tests/tiktok-parse.test.ts"
[[ -f tests/tiktok-live.test.ts ]] || fail "missing tests/tiktok-live.test.ts"
grep -q 'live_stripped' tests/tiktok-parse.test.ts \
  || fail "parse tests must cover live SSR that strips caption tracks"
grep -q 'tiktokcdn-us' tests/tiktok-parse.test.ts \
  || fail "parse tests must allow regional tiktokcdn-us caption hosts"
grep -q 'noCaptionReason' tests/tiktok-live.test.ts \
  || fail "live adapter tests must cover stripped SSR no_transcript"
grep -q 'CLIPAPI_LIVE' src/config.ts || fail "src/config.ts missing CLIPAPI_LIVE"
grep -q 'CLIPAPI_FIXTURE_ONLY' src/config.ts || fail "src/config.ts missing CLIPAPI_FIXTURE_ONLY"
grep -q 'createLiveTikTokAdapter' src/adapters/index.ts \
  || fail "createAppAdapter must know about the live adapter"
# Real-network tests belong in tests/live/ and are never invoked here.
if [[ -d tests/live ]]; then
  echo "note: tests/live/ is present and skipped (offline gate)"
fi
if [[ -f scripts/live-smoke.sh ]]; then
  if grep -R -E 'live-smoke\.sh|scripts/live-smoke' .github/workflows >/dev/null 2>&1; then
    fail "live-smoke.sh must not be called from GitHub Actions"
  fi
  if grep -R -E 'CLIPAPI_LIVE[[:space:]]*=[[:space:]]*1' .github/workflows >/dev/null 2>&1; then
    fail "CI must not set CLIPAPI_LIVE=1"
  fi
fi

echo "== HTTP/MCP do not import adapters/tiktok =="
for dir in src/http src/mcp; do
  if [[ -d "$dir" ]] && grep -R --include='*.ts' -l 'adapters/tiktok' "$dir" >/dev/null 2>&1; then
    fail "$dir imported adapters/tiktok"
  fi
done
if grep -R --include='*.ts' -E "from ['\"].*adapters/" src/mcp >/dev/null 2>&1; then
  fail "src/mcp must call core only (no adapter imports)"
fi

echo "== deploy artifacts (Dockerfile + runbook) =="
[[ -f Dockerfile ]] || fail "missing Dockerfile"
[[ -f .env.example ]] || fail "missing .env.example"
[[ -f deploy/runbook.md ]] || fail "missing deploy/runbook.md"
grep -q 'node:22' Dockerfile || fail "Dockerfile must use Node 22"
grep -qE '^USER[[:space:]]+node$' Dockerfile || fail "Dockerfile must run as non-root USER node"
grep -q 'PORT' Dockerfile || fail "Dockerfile must honor PORT"
grep -q 'src/server.ts' Dockerfile || fail "Dockerfile must start src/server.ts"
if grep -E 'CLIPAPI_LIVE[[:space:]]*=[[:space:]]*(1|true|yes|on)' Dockerfile >/dev/null; then
  fail "Dockerfile must not enable live TikTok"
fi
if grep -E 'STRIPE_(SECRET|WEBHOOK_SECRET)[[:space:]]*=' Dockerfile >/dev/null; then
  fail "Dockerfile must not bake STRIPE_* secrets"
fi
grep -q 'CLIPAPI_LIVE' .env.example || fail ".env.example missing CLIPAPI_LIVE"
grep -q 'CLIPAPI_FIXTURE_ONLY' .env.example || fail ".env.example missing CLIPAPI_FIXTURE_ONLY"
grep -q 'CLIPAPI_DATABASE' .env.example || fail ".env.example missing CLIPAPI_DATABASE"
grep -q 'STRIPE_SECRET' .env.example || fail ".env.example missing STRIPE_SECRET"
grep -q 'STRIPE_WEBHOOK_SECRET' .env.example || fail ".env.example missing STRIPE_WEBHOOK_SECRET"
if grep -E '^[[:space:]]*CLIPAPI_LIVE=1[[:space:]]*$' .env.example >/dev/null; then
  fail ".env.example must not default live TikTok on"
fi
if grep -E '^[[:space:]]*STRIPE_(SECRET|WEBHOOK_SECRET)=' .env.example >/dev/null; then
  fail ".env.example must keep STRIPE_* commented"
fi
if grep -E '^[[:space:]]*CLIPAPI_BOOTSTRAP_KEY=ck_(live|test)_' .env.example >/dev/null; then
  fail ".env.example must not ship a real bootstrap key"
fi
grep -q '/healthz' deploy/runbook.md || fail "runbook missing /healthz"
grep -q 'CLIPAPI_LIVE=1' deploy/runbook.md || fail "runbook missing how to enable live TikTok"
grep -q 'STRIPE_' deploy/runbook.md || fail "runbook missing how to enable Stripe"
grep -q 'docker build' deploy/runbook.md || fail "runbook missing docker build"
grep -q 'docker run' deploy/runbook.md || fail "runbook missing docker run"

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  # Fixture adapter only — never hit live TikTok. CLIPAPI_FIXTURE_ONLY wins over CLIPAPI_LIVE.
  unset CLIPAPI_LIVE || true
  unset STRIPE_SECRET STRIPE_WEBHOOK_SECRET STRIPE_SECRET_KEY STRIPE_API_KEY || true
  export CLIPAPI_FIXTURE_ONLY=1
  [[ "${CLIPAPI_LIVE:-}" != "1" ]] || fail "CLIPAPI_LIVE must stay unset in test.sh"
  test_log="$(mktemp)"
  trap 'rm -f "$test_log"' EXIT
  set +e
  npx tsx --test --test-reporter spec 'tests/**/*.test.ts' | tee "$test_log"
  test_status=${PIPESTATUS[0]}
  set -e
  [[ $test_status -eq 0 ]] || fail "unit tests failed"
  grep -Eq 'tests[[:space:]]+[1-9][0-9]*' "$test_log" \
    || fail "test runner reported 0 tests"
fi

echo "OK: buildable and testable"
