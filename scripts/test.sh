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
  tests/fixtures/html/deleted.html \
  tests/fixtures/html/blocked.html \
  tests/fixtures/html/captioned.vtt
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
if grep -R --include='*.ts' -E 'fetch\s*\(|https?://www\.tiktok\.com/api/' src/mcp >/dev/null 2>&1; then
  fail "src/mcp must not call live TikTok"
fi

echo "== live TikTok adapter is env-gated and offline-tested =="
[[ -f src/adapters/tiktok/parse.ts ]] || fail "missing src/adapters/tiktok/parse.ts"
[[ -f tests/tiktok-parse.test.ts ]] || fail "missing tests/tiktok-parse.test.ts"
[[ -f tests/tiktok-live.test.ts ]] || fail "missing tests/tiktok-live.test.ts"
grep -q 'CLIPAPI_LIVE' src/config.ts || fail "src/config.ts missing CLIPAPI_LIVE"
grep -q 'CLIPAPI_FIXTURE_ONLY' src/config.ts || fail "src/config.ts missing CLIPAPI_FIXTURE_ONLY"
grep -q 'createLiveTikTokAdapter' src/adapters/index.ts \
  || fail "createAppAdapter must know about the live adapter"
# Real-network tests belong in tests/live/ and are never invoked here.
if [[ -d tests/live ]]; then
  echo "note: tests/live/ is present and skipped (offline gate)"
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
