# Live smoke

Local process with `CLIPAPI_LIVE=1` and `CLIPAPI_FIXTURE_ONLY` unset.
Not run by `scripts/test.sh` or GitHub Actions. Fixture CI is a different unit.

| flow | result | proof |
|---|---|---|
| transcript | PASS-ERROR | http=422 code=no_transcript creditsCharged=0 video=7011618699945856262 url=https://www.tiktok.com/@rosssmith/video/7011618699945856262 requestId=req_b2b43fa6-bc5a-48d2-8c60-1371809284ce |
| error-case | PASS-ERROR | video_id=1 http=404 code=not_found creditsCharged=0 requestId=req_f22df0fd-2229-4c2c-ab59-d31e664e7100 |
| creator-latest | PASS | handle=nasa videos=0 creditsCharged=0 requestId=req_1f11fe99-05af-43c5-a78f-075700f1ef45 |
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

FAIL means a product bug (crash, invented cues, wrong envelope).
PASS-ERROR is a correct SPEC error from live upstream.
