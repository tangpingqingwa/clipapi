# Live smoke

Local process with `CLIPAPI_LIVE=1` and `CLIPAPI_FIXTURE_ONLY` unset.
Not run by `scripts/test.sh` or GitHub Actions. Fixture CI is a different unit.

| flow | result | proof |
|---|---|---|
| transcript | PASS-ERROR | http=422 code=no_transcript creditsCharged=0 video=7011618699945856262 url=https://www.tiktok.com/@rosssmith/video/7011618699945856262 requestId=req_5de1bcb6-255e-4d5b-b39c-57e10e446a62 |
| error-case | PASS-ERROR | video_id=1 http=404 code=not_found creditsCharged=0 requestId=req_01013eb5-7591-42a3-a076-24665e5fb03b |
| creator-latest | PASS | handle=nasa videos=0 creditsCharged=0 requestId=req_7051780b-5f3c-4b9a-9ca3-be624d37ab6d |
| mcp-get_transcript | PASS-ERROR | code=no_transcript creditsCharged=0 isError=true video=7011618699945856262 |
| stripe-checkout | BLOCKED-SECRET | STRIPE_SECRET unset; checkout not called |

## How this run was produced

- Command: `bash scripts/live-smoke.sh`
- Base URL: `http://127.0.0.1:3041`
- `CLIPAPI_LIVE=1`, `CLIPAPI_FIXTURE_ONLY` unset
- Bootstrap key prefix: `ck_live_…` (not committed)
- Server: started by this script on port `3041`
- Transcript URL: `https://www.tiktok.com/@rosssmith/video/7011618699945856262`
- Error video_id: `1`
- Creator handle: `@nasa`
- Stripe: `STRIPE_SECRET` unset → BLOCKED-SECRET

## Transcript candidates tried

First 200 with ≥1 real cue wins. Empty caption arrays are 422 `no_transcript`, never invented 200 cues.

- `http=422 code=no_transcript cues=0 credits=0 id=6718335390845095173 https://www.tiktok.com/@scout2015/video/6718335390845095173`
- `http=422 code=no_transcript cues=0 credits=0 id=6718335390845095173 https://www.tiktok.com/@tiktok/video/6718335390845095173`
- `http=422 code=no_transcript cues=0 credits=0 id=6893431881816149250 https://www.tiktok.com/@dearmebeauty/video/6893431881816149250`
- `http=422 code=no_transcript cues=0 credits=0 id=6927466633946598658 https://www.tiktok.com/@tiktok_australia/video/6927466633946598658`
- `http=422 code=no_transcript cues=0 credits=0 id=7011618699945856262 https://www.tiktok.com/@rosssmith/video/7011618699945856262`

## Egress

No captioned public TikTok was available from this egress. Live SSR still returns
`claInfo.captionInfos: []` / `subtitleInfos: []` (`noCaptionReason: 3`) on every
candidate. Honest result is PASS-ERROR `no_transcript` (422, 0 credits) — not a fake 200.

FAIL means a product bug (crash, invented cues, wrong envelope).
PASS-ERROR is a correct SPEC error from live upstream.
