import assert from "node:assert";
import test, { describe, it } from "node:test";
import {
  addExternalLinkTargets,
  extractExternalLinks,
  removeQuoteInlineFallback,
  stripHtml,
  transformMentions,
  truncateHtml,
} from "./html.ts";
import type { Actor } from "./schema.ts";

describe("extractExternalLinks()", () => {
  it("extracts http(s) links, ignoring mentions and hashtags", () => {
    assert.deepEqual(
      extractExternalLinks(
        '<p><a href="https://activitypub.academy/tags/%ED%95%B4%EC%8B%9C%ED%83%9C%EA%B7%B8" class="mention hashtag" rel="tag">#<span>해시태그</span></a> 테스트</p><p><span class="h-card"><a href="https://dorikom.squirrel-crocodile.ts.net/@h2t4" class="u-url mention">@<span>h2t4</span></a></span> 멘션 테스트</p><p><a href="https://hongminhee.org/" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">https://</span><span class="">hongminhee.org/</span><span class="invisible"></span></a> 링크 테스트</p>',
      ),
      [new URL("https://hongminhee.org/")],
    );
  });

  it("handles uppercase anchor tags and attributes", () => {
    assert.deepEqual(
      extractExternalLinks('<P><A HREF="https://example.com">link</A></P>'),
      [new URL("https://example.com")],
    );
  });

  it("resolves protocol-relative URLs as external links", () => {
    assert.deepEqual(
      extractExternalLinks('<p><a href="//example.com/foo">x</a></p>'),
      [new URL("https://example.com/foo")],
    );
  });

  it("skips explicitly excluded hrefs", () => {
    assert.deepEqual(
      extractExternalLinks(
        '<p><a href="https://forum.example/user/alice">@alice</a> <a href="https://example.com/story">story</a></p>',
        { excludeHrefs: ["https://forum.example/user/alice"] },
      ),
      [new URL("https://example.com/story")],
    );
  });
});

test("transformMentions() rewrites anchors matching persisted mention actors", () => {
  const actor = {
    iri: "https://forum.example/actor/alice",
    url: "https://forum.example/user/alice",
    aliases: [],
    name: "Alice Example",
    username: "alice",
    handle: "@alice@forum.example",
    accountId: null,
    avatarUrl: null,
    emojis: {},
  } as unknown as Actor;

  const html = transformMentions(
    '<p>Hello <a href="https://forum.example/user/alice">@alice</a></p>',
    [{ actor }],
    {},
  );

  assert.ok(html.includes('class="mention"'));
  assert.ok(html.includes('data-internal-href="/@alice@forum.example"'));
  assert.ok(
    html.includes(
      'onclick="location.href = this.dataset.internalHref; return false;"',
    ),
  );
});

describe("addExternalLinkTargets()", () => {
  it("adds target and rel to external http(s) links", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="https://example.com">link</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></p>',
    );
  });

  it("leaves same-origin absolute URLs untouched", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="https://hackers.pub/@user">user</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://hackers.pub/@user">user</a></p>',
    );
  });

  it("skips mentions and hashtags", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="https://mastodon.social/@user" class="u-url mention">@user</a> <a href="https://example.com/tags/foo" class="mention hashtag" rel="tag">#foo</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://mastodon.social/@user" class="u-url mention">@user</a> <a href="https://example.com/tags/foo" class="mention hashtag" rel="tag">#foo</a></p>',
    );
  });

  it("skips data-internal-href anchors", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="https://remote/@u" data-internal-href="/@u">@u</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://remote/@u" data-internal-href="/@u">@u</a></p>',
    );
  });

  it("skips relative and fragment links", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="/path">relative</a> <a href="#section">fragment</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="/path">relative</a> <a href="#section">fragment</a></p>',
    );
  });

  it("skips non-http(s) protocols", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="mailto:user@example.com">mail</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="mailto:user@example.com">mail</a></p>',
    );
  });

  it(
    "leaves anchors with an existing non-blank target untouched",
    () => {
      assert.deepEqual(
        addExternalLinkTargets(
          '<p><a href="https://example.com" target="_self">link</a></p>',
          new URL("https://hackers.pub"),
        ),
        '<p><a href="https://example.com" target="_self">link</a></p>',
      );
    },
  );

  it(
    "hardens rel on pre-existing target=_blank external links",
    () => {
      assert.deepEqual(
        addExternalLinkTargets(
          '<p><a href="https://evil.example" target="_blank">link</a></p>',
          new URL("https://hackers.pub"),
        ),
        '<p><a href="https://evil.example" target="_blank" rel="noopener noreferrer">link</a></p>',
      );
    },
  );

  it("merges rel tokens on pre-existing target=_blank links", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="https://evil.example" target="_blank" rel="nofollow">link</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://evil.example" target="_blank" rel="nofollow noopener noreferrer">link</a></p>',
    );
  });

  it("treats target value case-insensitively", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="https://evil.example" target=" _BLANK ">link</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://evil.example" target=" _BLANK " rel="noopener noreferrer">link</a></p>',
    );
  });

  it("merges rel tokens instead of overwriting", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="https://example.com" rel="nofollow">link</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://example.com" rel="nofollow noopener noreferrer" target="_blank">link</a></p>',
    );
  });

  it(
    "treats all http(s) links as external when no localDomain",
    () => {
      assert.deepEqual(
        addExternalLinkTargets(
          '<p><a href="https://hackers.pub/x">x</a></p>',
        ),
        '<p><a href="https://hackers.pub/x" target="_blank" rel="noopener noreferrer">x</a></p>',
      );
    },
  );

  it("accepts URL for localDomain", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="https://hackers.pub/@user">user</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://hackers.pub/@user">user</a></p>',
    );
  });

  it("returns input unchanged when no anchors present", () => {
    const html = "<p>no links here</p>";
    assert.deepEqual(
      addExternalLinkTargets(html, new URL("https://hackers.pub")),
      html,
    );
  });

  it("processes uppercase anchor tags", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<P><A HREF="https://example.com">link</A></P>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a></p>',
    );
  });

  it("marks cross-origin protocol-relative URLs as external", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="//example.com/foo">x</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="//example.com/foo" target="_blank" rel="noopener noreferrer">x</a></p>',
    );
  });

  it("leaves same-origin protocol-relative URLs untouched", () => {
    assert.deepEqual(
      addExternalLinkTargets(
        '<p><a href="//hackers.pub/@user">user</a></p>',
        new URL("https://hackers.pub"),
      ),
      '<p><a href="//hackers.pub/@user">user</a></p>',
    );
  });
});

describe("stripHtml()", () => {
  it("removes all HTML tags", () => {
    assert.deepEqual(
      stripHtml("<p>Hello <strong>world</strong></p>"),
      "Hello world",
    );
  });

  it("converts line breaks", () => {
    assert.deepEqual(
      stripHtml("<p>First paragraph</p><p>Second paragraph</p>"),
      "First paragraph\n\nSecond paragraph",
    );
    assert.deepEqual(
      stripHtml("<p>First paragraph</p>\n<p>Second paragraph</p>"),
      "First paragraph\n\nSecond paragraph",
    );
    assert.deepEqual(
      stripHtml("<p>First paragraph</p>\n\n<p>Second paragraph</p>"),
      "First paragraph\n\nSecond paragraph",
    );
    assert.deepEqual(
      stripHtml("<p>First paragraph</p>\r\n\r\n\r\n<p>Second paragraph</p>"),
      "First paragraph\n\nSecond paragraph",
    );
  });

  it("handles br tags", () => {
    assert.deepEqual(
      stripHtml("Line 1<br>Line 2"),
      "Line 1\nLine 2",
    );
  });

  it("handles complex nested HTML", () => {
    assert.deepEqual(
      stripHtml(
        '<div class="post"><h1>Title</h1><p>Hello <em>world</em> with <a href="https://example.com">link</a></p><ul><li>Item 1</li><li>Item <strong>2</strong></li></ul></div>',
      ),
      "Title\n\nHello world with link\n\nItem 1\nItem 2",
    );
  });

  it("handles HTML entities", () => {
    assert.deepEqual(
      stripHtml("<p>&lt;script&gt;alert('xss')&lt;/script&gt;</p>"),
      "<script>alert('xss')</script>",
    );
    assert.deepEqual(
      stripHtml("<p>&amp; &quot;quotes&quot; &apos;apostrophe&apos;</p>"),
      "& \"quotes\" 'apostrophe'",
    );
  });

  it("handles ActivityPub content", () => {
    assert.deepEqual(
      stripHtml(
        '<p><a href="https://activitypub.academy/tags/%ED%95%B4%EC%8B%9C%ED%83%9C%EA%B7%B8" class="mention hashtag" rel="tag">#<span>해시태그</span></a> 테스트</p><p><span class="h-card"><a href="https://dorikom.squirrel-crocodile.ts.net/@h2t4" class="u-url mention">@<span>h2t4</span></a></span> 멘션 테스트</p>',
      ),
      "#해시태그 테스트\n\n@h2t4 멘션 테스트",
    );
  });

  it("preserves Unicode and special characters", () => {
    assert.deepEqual(
      stripHtml("<p>🚀 Unicode emoji & 한글 text with <code>code</code></p>"),
      "🚀 Unicode emoji & 한글 text with code",
    );
  });

  it("handles malformed HTML", () => {
    assert.deepEqual(
      stripHtml("<p>Unclosed tag <span>content</p>more text"),
      "Unclosed tag content\n\nmore text",
    );
    assert.deepEqual(
      stripHtml("<>empty tags</>"),
      "empty tags",
    );
  });

  it("handles self-closing tags", () => {
    assert.deepEqual(
      stripHtml("Image: <img src='test.jpg' alt='Test' /> End"),
      "Image:  End",
    );
    assert.deepEqual(
      stripHtml("Break<br/>here<hr/>and<p>here"),
      "Break\nhere\nand\n\nhere",
    );
  });

  it("handles empty content", () => {
    assert.deepEqual(stripHtml(""), "");
    assert.deepEqual(stripHtml("<p></p>"), "");
    assert.deepEqual(stripHtml("<div><span></span></div>"), "");
  });
});

describe("truncateHtml()", () => {
  it("returns input unchanged when within budget", () => {
    assert.deepEqual(
      truncateHtml("<p>Hello world</p>", 100),
      "<p>Hello world</p>",
    );
    assert.deepEqual(truncateHtml("", 100), "");
  });

  it("returns empty string when maxChars is 0 or negative", () => {
    assert.deepEqual(truncateHtml("<p>Hello</p>", 0), "");
    assert.deepEqual(truncateHtml("<p>Hello</p>", -5), "");
  });

  it("truncates long text and appends ellipsis", () => {
    assert.deepEqual(
      truncateHtml("<p>Hello world from here</p>", 5),
      "<p>Hello…</p>",
    );
  });

  it("preserves wrapping tags around the cutoff", () => {
    // Cutoff falls inside the <strong>; the <strong> stays open until the
    // ellipsis, but everything after it is dropped.
    assert.deepEqual(
      truncateHtml("<p>Hello <strong>brave</strong> world</p>", 8),
      "<p>Hello <strong>br…</strong></p>",
    );
  });

  it("drops following siblings after the cutoff", () => {
    assert.deepEqual(
      truncateHtml("<p>First paragraph</p><p>Second paragraph</p>", 5),
      "<p>First…</p>",
    );
  });

  it("keeps non-text descendants that fit before the cutoff", () => {
    // The <img> is inside the kept paragraph; it doesn't consume any
    // characters and shouldn't be removed.
    const out = truncateHtml(
      `<p>Hi<img src="x.png" alt=""></p><p>more</p>`,
      10,
    );
    assert.deepEqual(out, `<p>Hi<img src="x.png" alt=""></p><p>more</p>`);
  });

  it("trims trailing whitespace before the ellipsis", () => {
    assert.deepEqual(
      truncateHtml("<p>Hello   world</p>", 8),
      "<p>Hello…</p>",
    );
  });

  it(
    "treats exact-fill text as the cutoff when more content follows",
    () => {
      // The first <p> is exactly 5 chars and there's more content after it,
      // so the ellipsis must land in the first paragraph and the <img> + the
      // second <p> must be dropped. The first paragraph keeps all 5 chars
      // (the budget is the visible-text cap, the ellipsis is overhead).
      assert.deepEqual(
        truncateHtml(
          `<p>Hello</p><img src="x.png" alt=""><p>World</p>`,
          5,
        ),
        "<p>Hello…</p>",
      );
    },
  );

  it(
    "counts and slices by grapheme clusters, not UTF-16 code units",
    () => {
      // Each emoji here is a multi-code-unit grapheme cluster. With a budget
      // of 3 we should keep the first three emoji intact (no half surrogates),
      // then append the ellipsis.
      assert.deepEqual(
        truncateHtml("<p>😀😁😂😃😄</p>", 3),
        "<p>😀😁😂…</p>",
      );
      // ZWJ-joined family emoji is one grapheme cluster.
      assert.deepEqual(
        truncateHtml("<p>👨‍👩‍👧‍👦 hello world</p>", 4),
        "<p>👨‍👩‍👧‍👦 he…</p>",
      );
    },
  );

  it("returns input unchanged when graphemes fit the budget", () => {
    // 5 emoji in input, budget 5 → fits, no truncation.
    assert.deepEqual(
      truncateHtml("<p>😀😁😂😃😄</p>", 5),
      "<p>😀😁😂😃😄</p>",
    );
  });
});

describe("removeQuoteInlineFallback()", () => {
  it(
    "removes Mastodon-style <p class=quote-inline> at beginning",
    () => {
      assert.deepEqual(
        removeQuoteInlineFallback(
          '<p class="quote-inline">RE: <a href="https://example.com">https://example.com</a></p><p>Normal text</p>',
        ),
        "<p>Normal text</p>",
      );
    },
  );

  it("removes standalone <p class=quote-inline>", () => {
    assert.deepEqual(
      removeQuoteInlineFallback(
        '<p class="quote-inline">RE: <a href="https://example.com">https://example.com</a></p>',
      ),
      "",
    );
  });

  it(
    "removes inline span and preceding <br> elements (newer Misskey format)",
    () => {
      assert.deepEqual(
        removeQuoteInlineFallback(
          '<p>Some text<br/><br/><span class="quote-inline">RE: <a href="https://example.com">https://example.com</a></span></p>',
        ),
        "<p>Some text</p>",
      );
    },
  );

  it(
    "removes inline span with internal <br> elements (Bluesky format)",
    () => {
      assert.deepEqual(
        removeQuoteInlineFallback(
          '<p>그럴리가없는데<span class="quote-inline"><br><br>RE: <a href="https://example.com">https://example.com</a></span></p>',
        ),
        "<p>그럴리가없는데</p>",
      );
    },
  );

  it(
    "removes inline span with QT text (Fedibird format)",
    () => {
      assert.deepEqual(
        removeQuoteInlineFallback(
          '<p>일부 텍스트<span class="quote-inline"><br/>QT: <a href="https://example.com">https://example.com</a></span></p>',
        ),
        "<p>일부 텍스트</p>",
      );
    },
  );

  it(
    "removes Misskey-transformed quote-inline pattern",
    () => {
      assert.deepEqual(
        removeQuoteInlineFallback(
          '<p><span>text<span class="quote-inline"><br><br>RE: </span></span><a class="quote-inline" href="https://example.com">https://example.com</a></p>',
        ),
        "<p><span>text</span></p>",
      );
    },
  );

  it("leaves content without quote-inline unchanged", () => {
    assert.deepEqual(
      removeQuoteInlineFallback("<p>Normal post without quotes</p>"),
      "<p>Normal post without quotes</p>",
    );
  });

  it(
    "removes paragraphs that become empty after span removal",
    () => {
      assert.deepEqual(
        removeQuoteInlineFallback(
          '<p><span class="quote-inline">RE: <a href="https://example.com">https://example.com</a></span></p>',
        ),
        "",
      );
    },
  );
});
