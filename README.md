# ClipAPI

Build contract: [SPEC.md](./SPEC.md).
How we work: [CONTRIBUTING.md](./CONTRIBUTING.md). `main` stays buildable and testable.

Transcripts, search, and creator archives for short video — TikTok, Instagram Reels, YouTube Shorts — one REST schema, one MCP server.

This is TranscriptAPI for the format YouTube no longer owns. Sell “stop fighting the blocks,” not “another caption toy.”

## Why this, and why overseas

US/EU builders and agents can already buy a decent YouTube transcript API (including Shimecki’s). Short video is still a mess: TikTok Research API is gated, Meta’s official paths want a business app review, Shorts are a different YouTube shape. Indie scrapers die weekly.

The buyer is the same person who already pays $5–49/mo for YouTube transcripts and now wants Reels and TikToks in the same pipeline.

## Exact demand

- Who: research agents, newsletter shops, social listening indies, DailyBrief
- What they already curse: official access forms, broken scrapers, one integration per app
- Queries: `tiktok transcript api`, `instagram reel transcript api`, `youtube shorts transcript api`
- Acceptance: `GET /v1/transcript?url=` succeeds with p50 < 80ms on cache hit; failures cost 0 credits

## Exact connector

Unstable public pages → a stable contract.

| Endpoint | Job | Credits |
|---|---|---|
| `/v1/transcript` | Timed text from a clip URL | 1 |
| `/v1/search` | Search TikTok / Reels / Shorts | 1 / page |
| `/v1/creators/{handle}/videos` | Public upload list | 1 / page |
| `/v1/creators/{handle}/latest` | New uploads (monitor) | free |

Same surface on REST, OpenAPI 3.1, MCP, `llms.txt`, and an agent skill. One JSON shape across the three apps.

Start with TikTok only if Reels is not stable in week two. Do not advertise a platform you cannot keep up.

## Exact combination

- TikTokToTranscript is the billboard and customer #1
- DailyBrief is customer #2 (creator monitors)
- Week one: seed MCP + skill into every agent directory that will take it (Cursor, Claude, OpenClaw, ChatGPT)
- SEO comparison posts vs. unofficial scrapers and vs. “how to get the TikTok Research API”

Line to steal: Build for agents. People search. Agents install skills.

## Cost control

- One VPS until ~100k requests / day
- Cache `(platform, video_id, lang)`; lists get a short TTL
- Failed / empty / blocked = 0 credits
- Price it so writing your own scraper is irrational: $5 / mo / 1,000 successful calls, cheaper annual, 100 free credits, no card

Margin is cache hits, not a high sticker.

## Business model

Credit subscription + top-ups. Low ACV, volume, renewal because the key is already in a cron.

Success: own products at 10k calls / day; 50 paying keys; blended bills in the $5–99 band that clear $2k / mo.

## Will not do

- No posting, DMs, live, or shop checkout
- No watermark-free video file CDN
- No “TikTok analytics suite”
- No default LLM summary on the hot path (that is DailyBrief’s bill, not this one)

## First two weeks

1. TikTok transcript + API key + credits
2. OpenAPI + MCP `get_transcript` / `search_clips`
3. curl / JS / Python plus one agent dialogue in the docs
4. Point TikTokToTranscript at this origin

## Dogfood

The entire free site goes through this API. Cache, backoff, slideshows, and geo failures get hit by us first.

## Risk

Platform policy. Pages say independent, not affiliated. Be ready to become “a more reliable wrapper” if an official self-serve path appears. The moat is not “we can scrape forever.”
