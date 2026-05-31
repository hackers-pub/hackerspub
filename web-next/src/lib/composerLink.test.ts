import { assertEquals } from "@std/assert";
import { ensureLinkInContent } from "./composerLink.ts";

const URL = "https://example.com/story";

Deno.test("ensureLinkInContent appends the URL on a new paragraph when absent", () => {
  assertEquals(
    ensureLinkInContent("My take on this.", URL),
    `My take on this.\n\n${URL}`,
  );
});

Deno.test("ensureLinkInContent leaves content unchanged when the URL is already present", () => {
  const bare = `Already linked ${URL} here.`;
  assertEquals(ensureLinkInContent(bare, URL), bare);
});

Deno.test("ensureLinkInContent does not duplicate a URL inside a markdown link", () => {
  const md = `See [the story](${URL}) for details.`;
  assertEquals(ensureLinkInContent(md, URL), md);
});

Deno.test("ensureLinkInContent returns just the URL for empty/whitespace content", () => {
  assertEquals(ensureLinkInContent("   ", URL), URL);
});

Deno.test("ensureLinkInContent trims surrounding whitespace before appending", () => {
  assertEquals(ensureLinkInContent("  spaced  ", URL), `spaced\n\n${URL}`);
});
