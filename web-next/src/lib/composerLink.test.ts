import assert from "node:assert/strict";
import test from "node:test";
import { ensureLinkInContent } from "./composerLink.ts";

const URL = "https://example.com/story";

test("ensureLinkInContent appends the URL on a new paragraph when absent", () => {
  assert.deepEqual(
    ensureLinkInContent("My take on this.", URL),
    `My take on this.\n\n${URL}`,
  );
});

test("ensureLinkInContent leaves content unchanged when the URL is already present", () => {
  const bare = `Already linked ${URL} here.`;
  assert.deepEqual(ensureLinkInContent(bare, URL), bare);
});

test("ensureLinkInContent does not duplicate a URL inside a markdown link", () => {
  const md = `See [the story](${URL}) for details.`;
  assert.deepEqual(ensureLinkInContent(md, URL), md);
});

test("ensureLinkInContent returns just the URL for empty/whitespace content", () => {
  assert.deepEqual(ensureLinkInContent("   ", URL), URL);
});

test("ensureLinkInContent trims surrounding whitespace before appending", () => {
  assert.deepEqual(ensureLinkInContent("  spaced  ", URL), `spaced\n\n${URL}`);
});
