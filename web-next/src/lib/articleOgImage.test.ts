import assert from "node:assert";
import test from "node:test";

import { articleOgImageUrl } from "./articleOgImage.ts";

test("articleOgImageUrl uses the original article image on the bare route", () => {
  assert.equal(
    articleOgImageUrl(
      "https://hackers.pub/@alice/2026/source-post",
      {
        language: "en",
        url: "https://hackers.pub/@alice/2026/source-post",
      },
      "en",
    ),
    "https://hackers.pub/@alice/2026/source-post/ogimage",
  );
});

test("articleOgImageUrl uses only the current translation image", () => {
  assert.equal(
    articleOgImageUrl(
      "https://hackers.pub/@alice/2026/source-post",
      {
        language: "ko-KR",
        url: "https://hackers.pub/@alice/2026/source-post/ko-KR",
      },
      "en",
    ),
    "https://hackers.pub/@alice/2026/source-post/ogimage?l=ko-KR",
  );
});

test("articleOgImageUrl derives the base article path from a translated content URL", () => {
  assert.equal(
    articleOgImageUrl(
      null,
      {
        language: "ko-KR",
        url: "https://hackers.pub/@alice/2026/source-post/ko-KR",
      },
      "en",
    ),
    "https://hackers.pub/@alice/2026/source-post/ogimage?l=ko-KR",
  );
});

test("articleOgImageUrl returns null without a usable content URL", () => {
  assert.equal(articleOgImageUrl(null, { language: "en" }, "en"), null);
  assert.equal(
    articleOgImageUrl(
      "https://hackers.pub/@alice/2026/source-post",
      null,
      "en",
    ),
    null,
  );
});
