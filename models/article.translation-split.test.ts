import assert from "node:assert/strict";
import test from "node:test";
import { splitTranslationTitleAndContent } from "./article.ts";

test("splitTranslationTitleAndContent() splits clean # Title + body", () => {
  const { title, content } = splitTranslationTitleAndContent(
    "# Translated title\n\nTranslated body line 1.\n\nTranslated body line 2.",
  );
  assert.equal(title, "Translated title");
  assert.equal(
    content,
    "Translated body line 1.\n\nTranslated body line 2.",
  );
});

test("splitTranslationTitleAndContent() drops preamble before the H1", () => {
  // The translator is prompted with `# Title\n\nbody`, so any text
  // before the matching H1 in the output is model commentary
  // (apologies, hedging, "translator's note" preambles, etc.) and
  // shouldn't end up in the persisted body.
  const { title, content } = splitTranslationTitleAndContent(
    "Note: I have preserved technical terms in their original form.\n" +
      "\n" +
      "# Translated title\n" +
      "\n" +
      "Translated body.",
  );
  assert.equal(title, "Translated title");
  assert.equal(content, "Translated body.");
});

test("splitTranslationTitleAndContent() falls back to first non-empty line when no H1", () => {
  // Some models occasionally drop the H1 framing entirely.  Without
  // a fallback the old strict-regex parser left `title=""` and put
  // the entire output into `content`, which renders as a
  // titleless article in the UI.
  const { title, content } = splitTranslationTitleAndContent(
    "\n" +
      "Translated title\n" +
      "\n" +
      "Translated body line 1.\n" +
      "Translated body line 2.",
  );
  assert.equal(title, "Translated title");
  assert.equal(
    content,
    "Translated body line 1.\nTranslated body line 2.",
  );
});

test("splitTranslationTitleAndContent() ignores ## H2 headings as title candidates", () => {
  // The regex must only match `# ` (single hash followed by
  // whitespace), not `## `, so a body whose first line is a
  // section heading rather than a document title doesn't have its
  // first H2 mis-promoted to the article title.
  const { title, content } = splitTranslationTitleAndContent(
    "## Section\n\nBody under section.",
  );
  // No H1 anywhere: fall back to first non-empty line.  The first
  // non-empty line is the H2, which gets used as the title.  Not
  // ideal but matches the no-H1 fallback behavior; the caller
  // upstream of this helper is supposed to prompt with `# Title`
  // and this is just a defensive tail.
  assert.equal(title, "## Section");
  assert.equal(content, "Body under section.");
});

test("splitTranslationTitleAndContent() preserves later ## H2 headings inside the body", () => {
  // A document with a real H1 followed by H2 sections must keep
  // the H2 sections in the body untouched.
  const { title, content } = splitTranslationTitleAndContent(
    "# Translated title\n" +
      "\n" +
      "Intro paragraph.\n" +
      "\n" +
      "## Section A\n" +
      "\n" +
      "Body of section A.\n" +
      "\n" +
      "## Section B\n" +
      "\n" +
      "Body of section B.",
  );
  assert.equal(title, "Translated title");
  assert.equal(
    content,
    "Intro paragraph.\n" +
      "\n" +
      "## Section A\n" +
      "\n" +
      "Body of section A.\n" +
      "\n" +
      "## Section B\n" +
      "\n" +
      "Body of section B.",
  );
});

test("splitTranslationTitleAndContent() handles entirely empty output", () => {
  const { title, content } = splitTranslationTitleAndContent("");
  assert.equal(title, "");
  assert.equal(content, "");
  const ws = splitTranslationTitleAndContent("   \n\n   \n");
  assert.equal(ws.title, "");
  assert.equal(ws.content, "");
});

test("splitTranslationTitleAndContent() handles H1-only output (no body)", () => {
  const { title, content } = splitTranslationTitleAndContent(
    "# Translated title\n",
  );
  assert.equal(title, "Translated title");
  assert.equal(content, "");
});

test("splitTranslationTitleAndContent() trims surrounding whitespace from the title", () => {
  const { title, content } = splitTranslationTitleAndContent(
    "#   Translated title with extra spaces   \n\nBody.",
  );
  assert.equal(title, "Translated title with extra spaces");
  assert.equal(content, "Body.");
});
