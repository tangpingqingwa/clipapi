import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  isAllowedSubtitleUrl,
  parseSubtitleBody,
  parseTikTokCreatorPage,
  parseTikTokVideoPage,
} from "../src/adapters/tiktok/parse.js";

const HTML_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/html");
const VIDEO_ID = "7123456789012345678";
const NO_CAPTION_ID = "7987654321098765432";
const DELETED_ID = "7000000000000000001";

function html(name: string): string {
  return readFileSync(join(HTML_DIR, name), "utf8");
}

test("captioned UNIVERSAL_DATA HTML yields metadata and a subtitle URL, no invented cues", () => {
  const parsed = parseTikTokVideoPage(html("captioned.html"), VIDEO_ID);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.videoId, VIDEO_ID);
  assert.equal(parsed.kind, "video");
  assert.equal(parsed.language, "en-US");
  assert.equal(parsed.durationMs, 8400);
  assert.equal(parsed.author.handle, "clipapi_fixture");
  assert.equal(parsed.author.id, "user_captioned");
  assert.equal(parsed.metadata.description, "Recorded caption fixture. Do not invent extra lines.");
  assert.equal(parsed.metadata.createTime, "2024-04-01T12:00:00.000Z");
  assert.equal(parsed.metadata.musicTitle, "Original sound");
  assert.equal(parsed.source, "platform_caption");
  assert.equal(parsed.cues.length, 0);
  assert.equal(
    parsed.subtitleUrl,
    "https://v16-webapp-prime.tiktok.com/captions/captioned.vtt",
  );
});

test("SIGI_STATE HTML prefers ASR when that is the only track", () => {
  const parsed = parseTikTokVideoPage(html("sigi_captioned.html"), VIDEO_ID);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.source, "platform_asr");
  assert.equal(parsed.author.handle, "clipapi_fixture");
  assert.equal(parsed.author.id, "user_captioned");
  assert.equal(parsed.subtitleUrl?.includes("captioned.vtt"), true);
});

test("no-caption HTML is no_transcript with zero cues", () => {
  const parsed = parseTikTokVideoPage(html("no_caption.html"), NO_CAPTION_ID);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "no_transcript");
  }
});

test("deleted HTML is not_found", () => {
  const parsed = parseTikTokVideoPage(html("deleted.html"), DELETED_ID);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "not_found");
  }
});

test("captcha HTML is upstream_blocked", () => {
  const parsed = parseTikTokVideoPage(html("blocked.html"), VIDEO_ID);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "upstream_blocked");
  }
});

test("HTML-escaped UNIVERSAL_DATA still parses", () => {
  const inner = JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        statusCode: 0,
        itemInfo: {
          itemStruct: {
            id: VIDEO_ID,
            desc: "escaped",
            createTime: 1711972800,
            video: {
              duration: 1,
              subtitleInfos: [
                {
                  languageCodeName: "eng-US",
                  url: "https://v16-webapp-prime.tiktok.com/captions/captioned.vtt",
                  source: "ISP",
                },
              ],
            },
            author: { uniqueId: "clipapi_fixture", id: "user_captioned" },
            music: { title: "Original sound" },
          },
        },
      },
    },
  }).replace(/"/g, "&quot;");
  const page = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${inner}</script>`;
  const parsed = parseTikTokVideoPage(page, VIDEO_ID);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.metadata.description, "escaped");
    assert.equal(parsed.cues.length, 0);
  }
});

test("unparseable HTML without a deleted marker is upstream_blocked, not a fake transcript", () => {
  const parsed = parseTikTokVideoPage("<html><body>nothing useful</body></html>", VIDEO_ID);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "upstream_blocked");
  }
});

test("parseSubtitleBody reads checked-in VTT without inventing lines", () => {
  const cues = parseSubtitleBody(html("captioned.vtt"));
  assert.deepEqual(cues, [
    { text: "Stop fighting TikTok blocks.", start: 0, duration: 2.1 },
    { text: "One credit, one JSON transcript.", start: 2.1, duration: 2.4 },
  ]);
});

test("parseSubtitleBody reads checked-in JSON caption milliseconds as seconds", () => {
  const cues = parseSubtitleBody(html("captioned-subs.json"));
  assert.deepEqual(cues, [
    { text: "Stop fighting TikTok blocks.", start: 0, duration: 2.1 },
    { text: "One credit, one JSON transcript.", start: 2.1, duration: 2.4 },
  ]);
});

test("parseSubtitleBody returns no cues for empty or junk bodies", () => {
  assert.deepEqual(parseSubtitleBody(""), []);
  assert.deepEqual(parseSubtitleBody("WEBVTT\n\n"), []);
  assert.deepEqual(parseSubtitleBody("{not json"), []);
  assert.deepEqual(parseSubtitleBody("{\"content\":[]}"), []);
});

test("lang preference selects a matching subtitle track", () => {
  const htmlWithBoth = html("captioned.html").replace(
    `"subtitleInfos": [`,
    `"subtitleInfos": [
                    {
                      "languageCodeName": "jpn-JP",
                      "url": "https://v16-webapp-prime.tiktok.com/captions/ja.vtt",
                      "source": "ASR"
                    },`,
  );
  const ja = parseTikTokVideoPage(htmlWithBoth, VIDEO_ID, "ja");
  assert.equal(ja.ok, true);
  if (ja.ok) {
    assert.equal(ja.language, "ja-JP");
    assert.equal(ja.subtitleUrl?.endsWith("ja.vtt"), true);
  }
  const fallback = parseTikTokVideoPage(htmlWithBoth, VIDEO_ID, "es");
  assert.equal(fallback.ok, true);
  if (fallback.ok) {
    assert.equal(fallback.language, "en-US");
  }
});

test("claInfo.captionInfos is accepted when subtitleInfos is missing", () => {
  const page = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.video-detail": {
        statusCode: 0,
        itemInfo: {
          itemStruct: {
            id: VIDEO_ID,
            desc: "claInfo only",
            createTime: 1711972800,
            video: {
              duration: 8.4,
              claInfo: {
                captionInfos: [
                  {
                    language: "eng-US",
                    url: "https://v16-webapp-prime.tiktok.com/captions/captioned.vtt",
                    isAutoGen: false,
                  },
                ],
              },
            },
            author: { uniqueId: "clipapi_fixture", id: "user_captioned" },
            music: { title: "Original sound" },
          },
        },
      },
    },
  })}</script>`;
  const parsed = parseTikTokVideoPage(page, VIDEO_ID);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.source, "platform_caption");
    assert.equal(parsed.subtitleUrl?.endsWith("captioned.vtt"), true);
  }
});

test("creator profile HTML with itemList yields those videos only", () => {
  const page = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.user-detail": {
        statusCode: 0,
        userInfo: {
          user: { uniqueId: "clipapi_fixture", id: "user_captioned" },
          itemList: [
            {
              id: VIDEO_ID,
              desc: "Recorded caption fixture.",
              createTime: 1711972800,
              video: { duration: 8.4, subtitleInfos: [{ url: "https://v16-webapp-prime.tiktok.com/captions/captioned.vtt" }] },
            },
          ],
        },
      },
    },
  })}</script>`;
  const parsed = parseTikTokCreatorPage(page, "clipapi_fixture", undefined, 15);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.page.handle, "clipapi_fixture");
    assert.equal(parsed.page.videos.length, 1);
    assert.equal(parsed.page.videos[0]?.videoId, VIDEO_ID);
    assert.equal(parsed.page.videos[0]?.hasCaptions, true);
    assert.equal(parsed.page.nextCursor, null);
  }
});

test("creator profile with empty itemList is an empty page, not invented uploads", () => {
  const page = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.user-detail": {
        statusCode: 0,
        userInfo: {
          user: { uniqueId: "nasa", id: "7664638705177150477" },
          stats: { videoCount: 31 },
          itemList: [],
        },
      },
    },
  })}</script>`;
  const parsed = parseTikTokCreatorPage(page, "nasa", undefined, 15);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.page.handle, "nasa");
    assert.equal(parsed.page.videos.length, 0);
    assert.equal(parsed.page.nextCursor, null);
  }
});

test("unknown creator status is not_found", () => {
  const page = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
    __DEFAULT_SCOPE__: {
      "webapp.user-detail": {
        statusCode: 10221,
        statusMsg: "user banned",
      },
    },
  })}</script>`;
  const parsed = parseTikTokCreatorPage(page, "missing_handle");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.equal(parsed.code, "not_found");
  }
});

test("isAllowedSubtitleUrl accepts TikTok CDN hosts over https only", () => {
  assert.equal(
    isAllowedSubtitleUrl(new URL("https://v16-webapp-prime.tiktok.com/captions/a.vtt")),
    true,
  );
  assert.equal(
    isAllowedSubtitleUrl(new URL("https://www.tiktok.com/aweme/v1/caption")),
    true,
  );
  assert.equal(isAllowedSubtitleUrl(new URL("http://www.tiktok.com/x.vtt")), false);
  assert.equal(isAllowedSubtitleUrl(new URL("https://evil.example/x.vtt")), false);
});
