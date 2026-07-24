import assert from "node:assert";
import test from "node:test";
import { splitTranslationTitleAndContent } from "./article.ts";

test("splitTranslationTitleAndContent() splits clean # Title + body", () => {
  const { title, content } = splitTranslationTitleAndContent(
    "# Translated title\n\nTranslated body line 1.\n\nTranslated body line 2.",
  );
  assert.equal(title, "Translated title");
  assert.equal(content, "Translated body line 1.\n\nTranslated body line 2.");
});

test("splitTranslationTitleAndContent() keeps preamble as the title rather than scanning deeper for an H1", () => {
  // The previous implementation took the first H1 anywhere in the
  // output, which handled this preamble case nicely but at the
  // cost of silently truncating content when the model omitted
  // the article-title H1 entirely and the body happened to
  // contain its own H1 section heading.  We deliberately accept
  // an uglier title here in exchange for never dropping body
  // content; the preamble stays visible (as the title) instead
  // of disappearing onto the floor, and the body keeps its `# `
  // framing intact.
  const { title, content } = splitTranslationTitleAndContent(
    "Note: I have preserved technical terms in their original form.\n" +
      "\n" +
      "# Translated title\n" +
      "\n" +
      "Translated body.",
  );
  assert.equal(
    title,
    "Note: I have preserved technical terms in their original form.",
  );
  assert.equal(content, "# Translated title\n\nTranslated body.");
});

test("splitTranslationTitleAndContent() uses the first line as the title when there is no H1 marker", () => {
  // Some models occasionally drop the H1 framing entirely.  The
  // first line stands in as the title so the article isn't
  // persisted titleless.
  const { title, content } = splitTranslationTitleAndContent(
    "\n" +
      "Translated title\n" +
      "\n" +
      "Translated body line 1.\n" +
      "Translated body line 2.",
  );
  assert.equal(title, "Translated title");
  assert.equal(content, "Translated body line 1.\nTranslated body line 2.");
});

test("splitTranslationTitleAndContent() does not strip a leading ## H2 marker from the first line", () => {
  // The H1-marker regex only matches `# ` (single hash followed by
  // whitespace), not `## `, so a first-line H2 is taken verbatim
  // as the title.  Mis-stripping would have produced a title
  // starting with `# Section`, which would render very wrong.
  const { title, content } = splitTranslationTitleAndContent(
    "## Section\n\nBody under section.",
  );
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
