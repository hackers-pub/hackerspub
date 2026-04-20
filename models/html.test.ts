import { assertEquals } from "@std/assert/equals";
import {
  addExternalLinkTargets,
  extractExternalLinks,
  stripHtml,
} from "./html.ts";

Deno.test("extractExternalLinks()", async (t) => {
  await t.step("extracts http(s) links, ignoring mentions and hashtags", () => {
    assertEquals(
      extractExternalLinks(
        '<p><a href="https://activitypub.academy/tags/%ED%95%B4%EC%8B%9C%ED%83%9C%EA%B7%B8" class="mention hashtag" rel="tag">#<span>해시태그</span></a> 테스트</p><p><span class="h-card"><a href="https://dorikom.squirrel-crocodile.ts.net/@h2t4" class="u-url mention">@<span>h2t4</span></a></span> 멘션 테스트</p><p><a href="https://hongminhee.org/" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">https://</span><span class="">hongminhee.org/</span><span class="invisible"></span></a> 링크 테스트</p>',
      ),
      [new URL("https://hongminhee.org/")],
    );
  });

  await t.step("handles uppercase anchor tags and attributes", () => {
    assertEquals(
      extractExternalLinks('<P><A HREF="https://example.com">link</A></P>'),
      [new URL("https://example.com")],
    );
  });

  await t.step("resolves protocol-relative URLs as external links", () => {
    assertEquals(
      extractExternalLinks('<p><a href="//example.com/foo">x</a></p>'),
      [new URL("https://example.com/foo")],
    );
  });
});

Deno.test("addExternalLinkTargets()", async (t) => {
  await t.step("adds target and rel to external http(s) links", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="https://example.com">link</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></p>',
    );
  });

  await t.step("leaves same-origin absolute URLs untouched", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="https://hackers.pub/@user">user</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://hackers.pub/@user">user</a></p>',
    );
  });

  await t.step("skips mentions and hashtags", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="https://mastodon.social/@user" class="u-url mention">@user</a> <a href="https://example.com/tags/foo" class="mention hashtag" rel="tag">#foo</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://mastodon.social/@user" class="u-url mention">@user</a> <a href="https://example.com/tags/foo" class="mention hashtag" rel="tag">#foo</a></p>',
    );
  });

  await t.step("skips data-internal-href anchors", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="https://remote/@u" data-internal-href="/@u">@u</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://remote/@u" data-internal-href="/@u">@u</a></p>',
    );
  });

  await t.step("skips relative and fragment links", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="/path">relative</a> <a href="#section">fragment</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="/path">relative</a> <a href="#section">fragment</a></p>',
    );
  });

  await t.step("skips non-http(s) protocols", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="mailto:user@example.com">mail</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="mailto:user@example.com">mail</a></p>',
    );
  });

  await t.step(
    "leaves anchors with an existing non-blank target untouched",
    () => {
      assertEquals(
        addExternalLinkTargets(
          '<p><a href="https://example.com" target="_self">link</a></p>',
          new URL("https://hackers.pub"),
        ),
        '<p><a href="https://example.com" target="_self">link</a></p>',
      );
    },
  );

  await t.step(
    "hardens rel on pre-existing target=_blank external links",
    () => {
      assertEquals(
        addExternalLinkTargets(
          '<p><a href="https://evil.example" target="_blank">link</a></p>',
          new URL("https://hackers.pub"),
        ),
        '<p><a href="https://evil.example" target="_blank" rel="noopener noreferrer">link</a></p>',
      );
    },
  );

  await t.step("merges rel tokens on pre-existing target=_blank links", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="https://evil.example" target="_blank" rel="nofollow">link</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://evil.example" target="_blank" rel="nofollow noopener noreferrer">link</a></p>',
    );
  });

  await t.step("treats target value case-insensitively", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="https://evil.example" target=" _BLANK ">link</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://evil.example" target=" _BLANK " rel="noopener noreferrer">link</a></p>',
    );
  });

  await t.step("merges rel tokens instead of overwriting", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="https://example.com" rel="nofollow">link</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://example.com" rel="nofollow noopener noreferrer" target="_blank">link</a></p>',
    );
  });

  await t.step(
    "treats all http(s) links as external when no localDomain",
    () => {
      assertEquals(
        addExternalLinkTargets(
          '<p><a href="https://hackers.pub/x">x</a></p>',
        ),
        '<p><a href="https://hackers.pub/x" target="_blank" rel="noopener noreferrer">x</a></p>',
      );
    },
  );

  await t.step("accepts URL for localDomain", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="https://hackers.pub/@user">user</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://hackers.pub/@user">user</a></p>',
    );
  });

  await t.step("returns input unchanged when no anchors present", () => {
    const html = "<p>no links here</p>";
    assertEquals(
      addExternalLinkTargets(html, new URL("https://hackers.pub")),
      html,
    );
  });

  await t.step("processes uppercase anchor tags", () => {
    assertEquals(
      addExternalLinkTargets(
        '<P><A HREF="https://example.com">link</A></P>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></p>',
    );
  });

  await t.step("marks cross-origin protocol-relative URLs as external", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="//example.com/foo">x</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="//example.com/foo" target="_blank" rel="noopener noreferrer">x</a></p>',
    );
  });

  await t.step("leaves same-origin protocol-relative URLs untouched", () => {
    assertEquals(
      addExternalLinkTargets(
        '<p><a href="//hackers.pub/@user">user</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="//hackers.pub/@user">user</a></p>',
    );
  });
});

Deno.test("stripHtml()", async (t) => {
  await t.step("removes all HTML tags", () => {
    assertEquals(
      stripHtml("<p>Hello <strong>world</strong></p>"),
      "Hello world",
    );
  });

  await t.step("converts line breaks", () => {
    assertEquals(
      stripHtml("<p>First paragraph</p><p>Second paragraph</p>"),
      "First paragraph\n\nSecond paragraph",
    );
    assertEquals(
      stripHtml("<p>First paragraph</p>\n<p>Second paragraph</p>"),
      "First paragraph\n\nSecond paragraph",
    );
    assertEquals(
      stripHtml("<p>First paragraph</p>\n\n<p>Second paragraph</p>"),
      "First paragraph\n\nSecond paragraph",
    );
    assertEquals(
      stripHtml("<p>First paragraph</p>\r\n\r\n\r\n<p>Second paragraph</p>"),
      "First paragraph\n\nSecond paragraph",
    );
  });

  await t.step("handles br tags", () => {
    assertEquals(
      stripHtml("Line 1<br>Line 2"),
      "Line 1\nLine 2",
    );
  });

  await t.step("handles complex nested HTML", () => {
    assertEquals(
      stripHtml(
        '<div class="post"><h1>Title</h1><p>Hello <em>world</em> with <a href="https://example.com">link</a></p><ul><li>Item 1</li><li>Item <strong>2</strong></li></ul></div>',
      ),
      "Title\n\nHello world with link\n\nItem 1\nItem 2",
    );
  });

  await t.step("handles HTML entities", () => {
    assertEquals(
      stripHtml("<p>&lt;script&gt;alert('xss')&lt;/script&gt;</p>"),
      "<script>alert('xss')</script>",
    );
    assertEquals(
      stripHtml("<p>&amp; &quot;quotes&quot; &apos;apostrophe&apos;</p>"),
      "& \"quotes\" 'apostrophe'",
    );
  });

  await t.step("handles ActivityPub content", () => {
    assertEquals(
      stripHtml(
        '<p><a href="https://activitypub.academy/tags/%ED%95%B4%EC%8B%9C%ED%83%9C%EA%B7%B8" class="mention hashtag" rel="tag">#<span>해시태그</span></a> 테스트</p><p><span class="h-card"><a href="https://dorikom.squirrel-crocodile.ts.net/@h2t4" class="u-url mention">@<span>h2t4</span></a></span> 멘션 테스트</p>',
      ),
      "#해시태그 테스트\n\n@h2t4 멘션 테스트",
    );
  });

  await t.step("preserves Unicode and special characters", () => {
    assertEquals(
      stripHtml("<p>🚀 Unicode emoji & 한글 text with <code>code</code></p>"),
      "🚀 Unicode emoji & 한글 text with code",
    );
  });

  await t.step("handles malformed HTML", () => {
    assertEquals(
      stripHtml("<p>Unclosed tag <span>content</p>more text"),
      "Unclosed tag content\n\nmore text",
    );
    assertEquals(
      stripHtml("<>empty tags</>"),
      "empty tags",
    );
  });

  await t.step("handles self-closing tags", () => {
    assertEquals(
      stripHtml("Image: <img src='test.jpg' alt='Test' /> End"),
      "Image:  End",
    );
    assertEquals(
      stripHtml("Break<br/>here<hr/>and<p>here"),
      "Break\nhere\nand\n\nhere",
    );
  });

  await t.step("handles empty content", () => {
    assertEquals(stripHtml(""), "");
    assertEquals(stripHtml("<p></p>"), "");
    assertEquals(stripHtml("<div><span></span></div>"), "");
  });
});
