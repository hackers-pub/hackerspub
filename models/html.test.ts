import { assertEquals } from "@std/assert/equals";
import { extractExternalLinks, stripHtml } from "./html.ts";

Deno.test("extractExternalLinks()", () => {
  assertEquals(
    extractExternalLinks(
      '<p><a href="https://activitypub.academy/tags/%ED%95%B4%EC%8B%9C%ED%83%9C%EA%B7%B8" class="mention hashtag" rel="tag">#<span>해시태그</span></a> 테스트</p><p><span class="h-card"><a href="https://dorikom.squirrel-crocodile.ts.net/@h2t4" class="u-url mention">@<span>h2t4</span></a></span> 멘션 테스트</p><p><a href="https://hongminhee.org/" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">https://</span><span class="">hongminhee.org/</span><span class="invisible"></span></a> 링크 테스트</p>',
    ),
    [new URL("https://hongminhee.org/")],
  );
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
