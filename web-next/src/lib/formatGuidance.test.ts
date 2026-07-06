import assert from "node:assert";
import test from "node:test";
import {
  buildNoteDraftContentFromArticle,
  countParagraphs,
  shouldSuggestArticleForNote,
  shouldSuggestNoteForArticle,
} from "./formatGuidance.ts";

test("shouldSuggestArticleForNote uses the 800 grapheme boundary", () => {
  assert.equal(shouldSuggestArticleForNote("a".repeat(799)), false);
  assert.equal(shouldSuggestArticleForNote("a".repeat(800)), true);
});

test("shouldSuggestArticleForNote counts non-empty paragraphs", () => {
  assert.equal(shouldSuggestArticleForNote("one\n\ntwo\n\nthree"), false);
  assert.equal(
    shouldSuggestArticleForNote("one\n\ntwo\n\nthree\n\nfour"),
    true,
  );
  assert.equal(countParagraphs("one\n\n\n  \n two"), 2);
});

test("shouldSuggestNoteForArticle uses the short article boundary", () => {
  assert.equal(shouldSuggestNoteForArticle("a".repeat(279)), true);
  assert.equal(shouldSuggestNoteForArticle("a".repeat(280)), false);
});

test("shouldSuggestNoteForArticle does not suggest for multi-paragraph articles", () => {
  assert.equal(shouldSuggestNoteForArticle("short\n\nbut separate"), false);
});

test("guidance counts grapheme clusters instead of UTF-16 code units", () => {
  const emoji = "👩‍💻";
  assert.equal(shouldSuggestArticleForNote(emoji.repeat(799)), false);
  assert.equal(shouldSuggestArticleForNote(emoji.repeat(800)), true);
});

test("buildNoteDraftContentFromArticle preserves title before body", () => {
  assert.equal(
    buildNoteDraftContentFromArticle(" Title ", " Body "),
    "Title\n\nBody",
  );
  assert.equal(buildNoteDraftContentFromArticle("", " Body "), "Body");
  assert.equal(buildNoteDraftContentFromArticle(" Title ", ""), "Title");
});
