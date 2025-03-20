import { assertEquals } from "@std/assert/equals";
import { extractExternalLinks } from "./html.ts";

Deno.test("extractExternalLinks()", () => {
  assertEquals(
    extractExternalLinks(
      '<p><a href="https://activitypub.academy/tags/%ED%95%B4%EC%8B%9C%ED%83%9C%EA%B7%B8" class="mention hashtag" rel="tag">#<span>해시태그</span></a> 테스트</p><p><span class="h-card"><a href="https://dorikom.squirrel-crocodile.ts.net/@h2t4" class="u-url mention">@<span>h2t4</span></a></span> 멘션 테스트</p><p><a href="https://hongminhee.org/" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">https://</span><span class="">hongminhee.org/</span><span class="invisible"></span></a> 링크 테스트</p>',
    ),
    [new URL("https://hongminhee.org/")],
  );
});
