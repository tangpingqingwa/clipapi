# Live smoke

Local process with `CLIPAPI_LIVE=1` and `CLIPAPI_FIXTURE_ONLY` unset.
Not run by `scripts/test.sh` or GitHub Actions. Fixture CI is a different unit.

| flow | result | proof |
|---|---|---|
| transcript | PASS | videoId=6989607394561035525 cues=6 creditsCharged=1 requestId=req_f8a4b8ca-3cce-45fe-909d-62119beab873 url=https://www.tiktok.com/@rosssmith/video/6989607394561035525 |
| error-case | PASS-ERROR | video_id=1 http=404 code=not_found creditsCharged=0 requestId=req_99b98265-04a1-4f6b-a0fb-26da31aa581e |
| creator-latest | PASS | handle=nasa videos=0 creditsCharged=0 requestId=req_aebbee9e-35c1-4e1f-814f-cae5b1920a9c |
| mcp-get_transcript | PASS | videoId=6989607394561035525 cues=6 creditsCharged=1 isError=false |
| stripe-checkout | BLOCKED-SECRET | STRIPE_SECRET unset; checkout not called |

## How this run was produced

- Command: `bash scripts/live-smoke.sh`
- Base URL: `http://127.0.0.1:3041`
- `CLIPAPI_LIVE=1`, `CLIPAPI_FIXTURE_ONLY` unset
- Bootstrap key prefix: `ck_live_…` (not committed)
- Server: started by this script on port `3041`
- Transcript URL: `https://www.tiktok.com/@rosssmith/video/6989607394561035525`
- Error video_id: `1`
- Creator handle: `@nasa`
- Stripe: `STRIPE_SECRET` unset → BLOCKED-SECRET

## Transcript candidates tried

First 200 with ≥1 real cue wins. Empty caption arrays are 422 `no_transcript`, never invented 200 cues.

- `http=200 code=ok cues=6 credits=1 id=6989607394561035525 https://www.tiktok.com/@rosssmith/video/6989607394561035525`

## Egress

Happy-path transcript PASSed from this machine (200, ≥1 cue, 1 credit).

FAIL means a product bug (crash, invented cues, wrong envelope).
PASS-ERROR is a correct SPEC error from live upstream.
