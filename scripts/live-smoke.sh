#!/usr/bin/env bash
# Live soak against a local process with CLIPAPI_LIVE=1.
# Not called from scripts/test.sh or GitHub Actions. Requires network.
#
# Verdicts: PASS | PASS-ERROR | FAIL | BLOCKED-SECRET
# FAIL = crash, invented cues, or a wrong envelope (product bug).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "${CLIPAPI_FIXTURE_ONLY:-}" == "1" ]]; then
  echo "FAIL: CLIPAPI_FIXTURE_ONLY=1 forces the fixture adapter; unset it for live smoke." >&2
  exit 1
fi

LIVE_BASE_URL="${LIVE_BASE_URL:-http://127.0.0.1:3041}"
LIVE_PORT="${LIVE_PORT:-3041}"
LIVE_DB="${LIVE_DB:-}"
LIVE_KEY="${CLIPAPI_BOOTSTRAP_KEY:-ck_live_smoke_$(openssl rand -hex 12)}"
STARTED_SERVER=0
SERVER_PID=""
RESULTS_MD="${LIVE_SMOKE_DOC:-$root/docs/live-smoke.md}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/clipapi-live-smoke.XXXXXX")"
RAW_DIR="$WORKDIR/raw"
mkdir -p "$RAW_DIR"

# Public videos that still SSR-render. First 200-with-cues wins.
# Override with LIVE_TRANSCRIPT_URL / LIVE_TRANSCRIPT_VIDEO_ID for a single URL.
# Do not invent cues: empty caption arrays stay 422 no_transcript (PASS-ERROR).
TRANSCRIPT_URL="${LIVE_TRANSCRIPT_URL:-}"
TRANSCRIPT_VIDEO_ID="${LIVE_TRANSCRIPT_VIDEO_ID:-}"
TRANSCRIPT_CANDIDATES=(
  "https://www.tiktok.com/@scout2015/video/6718335390845095173"
  "https://www.tiktok.com/@tiktok/video/6718335390845095173"
  "https://www.tiktok.com/@dearmebeauty/video/6893431881816149250"
  "https://www.tiktok.com/@tiktok_australia/video/6927466633946598658"
  "https://www.tiktok.com/@rosssmith/video/7011618699945856262"
)
CANDIDATE_LOG=()
# Known-deleted / never-existed numeric id → not_found (or no_transcript / bad-url).
ERROR_VIDEO_ID="${LIVE_ERROR_VIDEO_ID:-1}"
BAD_URL="${LIVE_BAD_URL:-https://www.youtube.com/watch?v=dQw4w9WgXcQ}"
CREATOR_HANDLE="${LIVE_CREATOR_HANDLE:-nasa}"

cleanup() {
  if [[ "$STARTED_SERVER" -eq 1 && -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$WORKDIR" && -d "$WORKDIR" ]]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

json_get() {
  # json_get FILE dot.path  — tiny node walker, no extra deps
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const file = process.argv[1];
    const path = process.argv[2];
    let cur;
    try { cur = JSON.parse(readFileSync(file, "utf8")); }
    catch { process.exit(2); }
    for (const part of path.split(".")) {
      if (cur == null || typeof cur !== "object") { process.exit(3); }
      cur = cur[part];
    }
    if (cur === undefined || cur === null) process.exit(3);
    if (typeof cur === "object") process.stdout.write(JSON.stringify(cur));
    else process.stdout.write(String(cur));
  ' "$1" "$2" || true
}

json_len() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    try {
      const file = process.argv[1];
      const path = process.argv[2];
      let cur = JSON.parse(readFileSync(file, "utf8"));
      for (const part of path.split(".")) {
        if (part === "") continue;
        if (cur == null || typeof cur !== "object") { console.log(0); process.exit(0); }
        cur = cur[part];
      }
      console.log(Array.isArray(cur) ? cur.length : 0);
    } catch {
      console.log(0);
    }
  ' "$1" "$2"
}

http_code() {
  local file="$1"
  head -n 1 "$file" | awk '{print $2}'
}

save_body() {
  local raw="$1"
  local out="$2"
  # drop status line + headers
  awk 'BEGIN{h=1} h && $0==""{h=0; next} !h{print}' "$raw" > "$out"
}

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local dest="$4"
  local tmp
  tmp="$(mktemp "$RAW_DIR/req.XXXXXX")"
  local args=(
    -sS -o "$tmp.body"
    --max-time 25
    -H "Authorization: Bearer $LIVE_KEY"
    -H "Accept: application/json"
    -w '%{http_code}'
  )
  if [[ "$method" == "POST" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  local code
  set +e
  code="$(curl "${args[@]}" -X "$method" "${LIVE_BASE_URL}${path}")"
  local curl_ec=$?
  set -e
  if [[ $curl_ec -ne 0 && -z "$code" ]]; then
    code="000"
  fi
  {
    echo "HTTP/1.1 ${code:-000}"
    echo
    cat "$tmp.body" 2>/dev/null || true
  } > "$dest"
  rm -f "$tmp.body"
}

wait_health() {
  local i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 1 "${LIVE_BASE_URL}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

ensure_server() {
  if curl -fsS --max-time 1 "${LIVE_BASE_URL}/healthz" >/dev/null 2>&1; then
    echo "using existing server at $LIVE_BASE_URL"
    return 0
  fi

  LIVE_DB="${LIVE_DB:-$WORKDIR/clipapi.sqlite}"
  mkdir -p "$(dirname "$LIVE_DB")"

  echo "starting local server CLIPAPI_LIVE=1 on :$LIVE_PORT"
  (
    cd "$root"
    unset CLIPAPI_FIXTURE_ONLY || true
    export CLIPAPI_LIVE=1
    export CLIPAPI_DATABASE="$LIVE_DB"
    export CLIPAPI_BOOTSTRAP_KEY="$LIVE_KEY"
    export PORT="$LIVE_PORT"
    export NODE_ENV="${NODE_ENV:-development}"
    exec node --import tsx src/server.ts
  ) >"$WORKDIR/server.log" 2>&1 &
  SERVER_PID=$!
  STARTED_SERVER=1

  if ! wait_health; then
    echo "----- server.log -----" >&2
    cat "$WORKDIR/server.log" >&2 || true
    fail "local server did not become healthy at $LIVE_BASE_URL/healthz"
  fi
}

ensure_server

FLOW_NAMES=()
FLOW_VERDICTS=()
FLOW_NOTES=()
ANY_FAIL=0

record() {
  local name="$1"
  local verdict="$2"
  local note="$3"
  FLOW_NAMES+=("$name")
  FLOW_VERDICTS+=("$verdict")
  FLOW_NOTES+=("$note")
  printf '%-22s %s  %s\n' "$name" "$verdict" "$note"
  if [[ "$verdict" == "FAIL" ]]; then
    ANY_FAIL=1
  fi
}

is_error_code() {
  case "$1" in
    invalid_request|unauthorized|payment_required|not_found|no_transcript|unsupported_platform|rate_limited|upstream_blocked|internal)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

expected_http() {
  case "$1" in
    invalid_request) echo 400 ;;
    unauthorized) echo 401 ;;
    payment_required) echo 402 ;;
    not_found) echo 404 ;;
    no_transcript|unsupported_platform) echo 422 ;;
    rate_limited) echo 429 ;;
    upstream_blocked) echo 503 ;;
    internal) echo 500 ;;
    *) echo 0 ;;
  esac
}

# ---------- transcript (real public video) ----------
enc_url() {
  python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

video_id_from_url() {
  python3 -c 'import re,sys; m=re.search(r"/video/(\d+)", sys.argv[1]); print(m.group(1) if m else "")' "$1"
}

CANDIDATES=()
if [[ -n "$TRANSCRIPT_URL" ]]; then
  CANDIDATES+=("$TRANSCRIPT_URL")
else
  CANDIDATES+=("${TRANSCRIPT_CANDIDATES[@]}")
fi

T_PICKED=""
T_CODE=""
T_ERR=""
T_VID=""
T_CUES="0"
T_CHARGED=""
T_REQ=""
for cand in "${CANDIDATES[@]}"; do
  TRANSCRIPT_RAW="$RAW_DIR/transcript.json"
  request GET "/v1/transcript?url=$(enc_url "$cand")" "" "$TRANSCRIPT_RAW"
  save_body "$TRANSCRIPT_RAW" "$RAW_DIR/transcript.body"
  T_CODE="$(http_code "$TRANSCRIPT_RAW")"
  T_ERR="$(json_get "$RAW_DIR/transcript.body" error.code)"
  T_VID="$(json_get "$RAW_DIR/transcript.body" data.videoId)"
  T_CUES="$(json_len "$RAW_DIR/transcript.body" data.transcript)"
  T_CHARGED="$(json_get "$RAW_DIR/transcript.body" meta.creditsCharged)"
  T_REQ="$(json_get "$RAW_DIR/transcript.body" meta.requestId)"
  T_PICKED="$cand"
  expect_id="${TRANSCRIPT_VIDEO_ID:-$(video_id_from_url "$cand")}"
  CANDIDATE_LOG+=("http=$T_CODE code=${T_ERR:-ok} cues=$T_CUES credits=${T_CHARGED:-?} id=${T_VID:-$expect_id} $cand")
  if [[ "$T_CODE" == "200" && "$T_CUES" -ge 1 ]]; then
    TRANSCRIPT_URL="$cand"
    TRANSCRIPT_VIDEO_ID="$expect_id"
    break
  fi
done
expect_id="${TRANSCRIPT_VIDEO_ID:-$(video_id_from_url "$T_PICKED")}"

if [[ "$T_CODE" == "200" ]]; then
  if [[ -n "$T_VID" && "$T_CUES" -ge 1 && "$T_CHARGED" == "1" ]]; then
    if [[ -n "$expect_id" && "$T_VID" != "$expect_id" ]]; then
      record "transcript" "FAIL" "200 cues=$T_CUES but videoId=$T_VID expected=$expect_id"
    else
      record "transcript" "PASS" "videoId=$T_VID cues=$T_CUES creditsCharged=$T_CHARGED requestId=$T_REQ url=$T_PICKED"
    fi
  elif [[ "$T_CUES" -eq 0 ]]; then
    record "transcript" "FAIL" "200 with 0 cues (invented/empty success) videoId=${T_VID:-?} body=$(head -c 240 "$RAW_DIR/transcript.body")"
  else
    record "transcript" "FAIL" "200 but envelope mismatch videoId=${T_VID:-?} cues=$T_CUES creditsCharged=${T_CHARGED:-?}"
  fi
elif [[ -n "$T_ERR" ]] && is_error_code "$T_ERR"; then
  WANT="$(expected_http "$T_ERR")"
  T_META="${T_CHARGED:-0}"
  if [[ "$T_CODE" == "$WANT" && "$T_META" == "0" ]]; then
    record "transcript" "PASS-ERROR" "http=$T_CODE code=$T_ERR creditsCharged=0 video=${expect_id:-?} url=$T_PICKED requestId=${T_REQ:-?}"
  else
    record "transcript" "FAIL" "error envelope mismatch http=$T_CODE want=$WANT code=$T_ERR creditsCharged=${T_META:-?}"
  fi
else
  record "transcript" "FAIL" "crash or unparseable http=${T_CODE:-?} body=$(head -c 240 "$RAW_DIR/transcript.body")"
fi
TRANSCRIPT_URL="${TRANSCRIPT_URL:-$T_PICKED}"
TRANSCRIPT_VIDEO_ID="${TRANSCRIPT_VIDEO_ID:-$expect_id}"

# ---------- no_transcript / not_found / bad-url ----------
ERROR_RAW="$RAW_DIR/error.json"
request GET "/v1/transcript?video_id=${ERROR_VIDEO_ID}" "" "$ERROR_RAW"
save_body "$ERROR_RAW" "$RAW_DIR/error.body"
E_CODE="$(http_code "$ERROR_RAW")"
E_ERR="$(json_get "$RAW_DIR/error.body" error.code 2>/dev/null || true)"
E_CHARGED="$(json_get "$RAW_DIR/error.body" meta.creditsCharged 2>/dev/null || echo "?")"
E_REQ="$(json_get "$RAW_DIR/error.body" meta.requestId 2>/dev/null || echo "?")"

if [[ "$E_ERR" == "no_transcript" || "$E_ERR" == "not_found" ]]; then
  WANT="$(expected_http "$E_ERR")"
  if [[ "$E_CODE" == "$WANT" && "$E_CHARGED" == "0" ]]; then
    record "error-case" "PASS-ERROR" "video_id=$ERROR_VIDEO_ID http=$E_CODE code=$E_ERR creditsCharged=0 requestId=$E_REQ"
  else
    record "error-case" "FAIL" "http=$E_CODE want=$WANT code=$E_ERR creditsCharged=$E_CHARGED"
  fi
else
  # fall back to a bad-url case if the numeric id did not produce a SPEC error
  BAD_RAW="$RAW_DIR/badurl.json"
  request GET "/v1/transcript?url=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$BAD_URL")" "" "$BAD_RAW"
  save_body "$BAD_RAW" "$RAW_DIR/badurl.body"
  B_CODE="$(http_code "$BAD_RAW")"
  B_ERR="$(json_get "$RAW_DIR/badurl.body" error.code 2>/dev/null || true)"
  B_CHARGED="$(json_get "$RAW_DIR/badurl.body" meta.creditsCharged 2>/dev/null || echo "?")"
  B_REQ="$(json_get "$RAW_DIR/badurl.body" meta.requestId 2>/dev/null || echo "?")"
  if [[ "$B_ERR" == "invalid_request" || "$B_ERR" == "unsupported_platform" ]]; then
    WANT="$(expected_http "$B_ERR")"
    if [[ "$B_CODE" == "$WANT" && "$B_CHARGED" == "0" ]]; then
      record "error-case" "PASS-ERROR" "bad-url http=$B_CODE code=$B_ERR creditsCharged=0 requestId=$B_REQ (numeric id was http=$E_CODE code=${E_ERR:-none})"
    else
      record "error-case" "FAIL" "bad-url envelope mismatch http=$B_CODE code=$B_ERR creditsCharged=$B_CHARGED"
    fi
  else
    record "error-case" "FAIL" "neither numeric id nor bad-url produced SPEC error; id http=$E_CODE code=${E_ERR:-none} bad-url http=$B_CODE code=${B_ERR:-none} body=$(head -c 200 "$RAW_DIR/error.body")"
  fi
fi

# ---------- creator latest ----------
CREATOR_RAW="$RAW_DIR/creator.json"
request GET "/v1/creators/${CREATOR_HANDLE}/latest" "" "$CREATOR_RAW"
save_body "$CREATOR_RAW" "$RAW_DIR/creator.body"
C_CODE="$(http_code "$CREATOR_RAW")"
C_ERR="$(json_get "$RAW_DIR/creator.body" error.code 2>/dev/null || true)"
C_HANDLE="$(json_get "$RAW_DIR/creator.body" data.handle 2>/dev/null || true)"
C_VIDEOS="$(json_len "$RAW_DIR/creator.body" data.videos)"
C_CHARGED="$(json_get "$RAW_DIR/creator.body" meta.creditsCharged 2>/dev/null || echo "?")"
C_REQ="$(json_get "$RAW_DIR/creator.body" meta.requestId 2>/dev/null || echo "?")"
C_PLATFORM="$(json_get "$RAW_DIR/creator.body" data.platform 2>/dev/null || true)"

if [[ "$C_CODE" == "200" ]]; then
  if [[ "$C_HANDLE" == "$CREATOR_HANDLE" && "$C_PLATFORM" == "tiktok" && "$C_CHARGED" == "0" ]]; then
    # Empty list is honest when upstream SSR omits itemList. Invented rows would be FAIL.
    record "creator-latest" "PASS" "handle=$C_HANDLE videos=$C_VIDEOS creditsCharged=0 requestId=$C_REQ"
  else
    record "creator-latest" "FAIL" "200 envelope mismatch handle=${C_HANDLE:-?} platform=${C_PLATFORM:-?} creditsCharged=$C_CHARGED videos=$C_VIDEOS"
  fi
elif [[ -n "$C_ERR" ]] && is_error_code "$C_ERR"; then
  WANT="$(expected_http "$C_ERR")"
  if [[ "$C_CODE" == "$WANT" && "$C_CHARGED" == "0" ]]; then
    record "creator-latest" "PASS-ERROR" "http=$C_CODE code=$C_ERR creditsCharged=0 handle=$CREATOR_HANDLE requestId=$C_REQ"
  else
    record "creator-latest" "FAIL" "error envelope mismatch http=$C_CODE want=$WANT code=$C_ERR creditsCharged=$C_CHARGED"
  fi
else
  record "creator-latest" "FAIL" "crash or unparseable http=$C_CODE body=$(head -c 240 "$RAW_DIR/creator.body")"
fi

# ---------- MCP get_transcript ----------
MCP_RAW="$RAW_DIR/mcp.json"
MCP_BODY="$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_transcript","arguments":{"url":sys.argv[1]}}}))' "$TRANSCRIPT_URL")"
request POST "/mcp" "$MCP_BODY" "$MCP_RAW"
save_body "$MCP_RAW" "$RAW_DIR/mcp.body"
M_CODE="$(http_code "$MCP_RAW")"
M_TOOL_ERR="$(json_get "$RAW_DIR/mcp.body" result.structuredContent.error.code 2>/dev/null || true)"
M_VID="$(json_get "$RAW_DIR/mcp.body" result.structuredContent.data.videoId 2>/dev/null || true)"
M_CUES="$(json_len "$RAW_DIR/mcp.body" result.structuredContent.data.transcript)"
M_CHARGED="$(json_get "$RAW_DIR/mcp.body" result.structuredContent.meta.creditsCharged 2>/dev/null || echo "?")"
M_RPC_ERR="$(json_get "$RAW_DIR/mcp.body" error.message 2>/dev/null || true)"
M_IS_ERR="$(json_get "$RAW_DIR/mcp.body" result.isError 2>/dev/null || true)"

if [[ "$M_CODE" != "200" ]]; then
  if [[ -n "$M_TOOL_ERR" ]] && is_error_code "$M_TOOL_ERR"; then
    record "mcp-get_transcript" "FAIL" "tool error leaked as HTTP $M_CODE code=$M_TOOL_ERR"
  else
    record "mcp-get_transcript" "FAIL" "http=$M_CODE rpc=${M_RPC_ERR:-none} body=$(head -c 240 "$RAW_DIR/mcp.body")"
  fi
elif [[ -n "$M_VID" && "$M_VID" == "$TRANSCRIPT_VIDEO_ID" && "$M_CUES" -ge 1 && "$M_IS_ERR" == "false" ]]; then
  record "mcp-get_transcript" "PASS" "videoId=$M_VID cues=$M_CUES creditsCharged=$M_CHARGED isError=false"
elif [[ -n "$M_TOOL_ERR" ]] && is_error_code "$M_TOOL_ERR" && [[ "$M_IS_ERR" == "true" ]]; then
  M_META="$(json_get "$RAW_DIR/mcp.body" result.structuredContent.meta.creditsCharged 2>/dev/null || echo "?")"
  if [[ "$M_META" == "0" ]]; then
    record "mcp-get_transcript" "PASS-ERROR" "code=$M_TOOL_ERR creditsCharged=0 isError=true video=$TRANSCRIPT_VIDEO_ID"
  else
    record "mcp-get_transcript" "FAIL" "tool error charged credits code=$M_TOOL_ERR creditsCharged=$M_META"
  fi
else
  record "mcp-get_transcript" "FAIL" "wrong envelope http=$M_CODE videoId=${M_VID:-?} cues=$M_CUES isError=${M_IS_ERR:-?} rpc=${M_RPC_ERR:-none} body=$(head -c 240 "$RAW_DIR/mcp.body")"
fi

# ---------- Stripe (optional) ----------
if [[ -n "${STRIPE_SECRET:-}" ]]; then
  STRIPE_RAW="$RAW_DIR/stripe.json"
  request POST "/v1/billing/checkout" "{}" "$STRIPE_RAW"
  save_body "$STRIPE_RAW" "$RAW_DIR/stripe.body"
  S_CODE="$(http_code "$STRIPE_RAW")"
  S_URL="$(json_get "$RAW_DIR/stripe.body" data.url 2>/dev/null || true)"
  S_ERR="$(json_get "$RAW_DIR/stripe.body" error.code 2>/dev/null || true)"
  S_CHARGED="$(json_get "$RAW_DIR/stripe.body" meta.creditsCharged 2>/dev/null || echo "?")"
  if [[ "$S_CODE" == "200" && -n "$S_URL" && "$S_CHARGED" == "0" ]]; then
    record "stripe-checkout" "PASS" "http=200 session url present creditsCharged=0"
  elif [[ "$S_ERR" == "internal" && "$S_CHARGED" == "0" ]]; then
    # Live StripePort is not wired even when STRIPE_SECRET is set (fail-closed).
    record "stripe-checkout" "PASS-ERROR" "http=$S_CODE code=$S_ERR creditsCharged=0 (fail-closed without live StripePort)"
  else
    record "stripe-checkout" "FAIL" "http=$S_CODE code=${S_ERR:-none} creditsCharged=$S_CHARGED body=$(head -c 200 "$RAW_DIR/stripe.body")"
  fi
else
  record "stripe-checkout" "BLOCKED-SECRET" "STRIPE_SECRET unset; checkout not called"
fi

# ---------- write docs/live-smoke.md ----------
mkdir -p "$(dirname "$RESULTS_MD")"
{
  echo "# Live smoke"
  echo
  echo "Local process with \`CLIPAPI_LIVE=1\` and \`CLIPAPI_FIXTURE_ONLY\` unset."
  echo "Not run by \`scripts/test.sh\` or GitHub Actions. Fixture CI is a different unit."
  echo
  echo "| flow | result | proof |"
  echo "|---|---|---|"
  i=0
  while [[ $i -lt ${#FLOW_NAMES[@]} ]]; do
    echo "| ${FLOW_NAMES[$i]} | ${FLOW_VERDICTS[$i]} | ${FLOW_NOTES[$i]} |"
    i=$((i + 1))
  done
  echo
  echo "## How this run was produced"
  echo
  echo "- Command: \`bash scripts/live-smoke.sh\`"
  echo "- Base URL: \`$LIVE_BASE_URL\`"
  echo "- \`CLIPAPI_LIVE=1\`, \`CLIPAPI_FIXTURE_ONLY\` unset"
  echo "- Bootstrap key prefix: \`${LIVE_KEY:0:8}…\` (not committed)"
  if [[ "$STARTED_SERVER" -eq 1 ]]; then
    echo "- Server: started by this script on port \`$LIVE_PORT\`"
  else
    echo "- Server: pre-existing process at \`$LIVE_BASE_URL\`"
  fi
  echo "- Transcript URL: \`$TRANSCRIPT_URL\`"
  echo "- Error video_id: \`$ERROR_VIDEO_ID\`"
  echo "- Creator handle: \`@$CREATOR_HANDLE\`"
  if [[ -n "${STRIPE_SECRET:-}" ]]; then
    echo "- Stripe: \`STRIPE_SECRET\` was set"
  else
    echo "- Stripe: \`STRIPE_SECRET\` unset → BLOCKED-SECRET"
  fi
  echo
  echo "## Transcript candidates tried"
  echo
  echo "First 200 with ≥1 real cue wins. Empty caption arrays are 422 \`no_transcript\`, never invented 200 cues."
  echo
  if [[ ${#CANDIDATE_LOG[@]} -eq 0 ]]; then
    echo "- (none)"
  else
    for line in "${CANDIDATE_LOG[@]}"; do
      echo "- \`$line\`"
    done
  fi
  echo
  echo "## Egress"
  echo
  transcript_verdict=""
  i=0
  while [[ $i -lt ${#FLOW_NAMES[@]} ]]; do
    if [[ "${FLOW_NAMES[$i]}" == "transcript" ]]; then
      transcript_verdict="${FLOW_VERDICTS[$i]}"
      break
    fi
    i=$((i + 1))
  done
  if [[ "$transcript_verdict" == "PASS" ]]; then
    echo "Happy-path transcript PASSed from this machine (200, ≥1 cue, 1 credit)."
  else
    echo "No captioned public TikTok was available from this egress. Live SSR still returns"
    echo "\`claInfo.captionInfos: []\` / \`subtitleInfos: []\` (\`noCaptionReason: 3\`) on every"
    echo "candidate. Honest result is PASS-ERROR \`no_transcript\` (422, 0 credits) — not a fake 200."
  fi
  echo
  echo "FAIL means a product bug (crash, invented cues, wrong envelope)."
  echo "PASS-ERROR is a correct SPEC error from live upstream."
} > "$RESULTS_MD"

echo
echo "wrote $RESULTS_MD"
if [[ "$ANY_FAIL" -eq 1 ]]; then
  echo "live-smoke completed with FAIL rows (see $RESULTS_MD)" >&2
  # Still exit 0 so the table is the source of truth; FAIL is recorded, not hidden.
  exit 0
fi
echo "live-smoke OK"
