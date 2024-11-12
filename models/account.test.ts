import { assertEquals } from "@std/assert/equals";
import { fetchAccountLinkMetadata } from "./account.ts";

Deno.test({
  name: "fetchAccountLinkMetadata()",
  sanitizeResources: false,
  async fn() {
    assertEquals(
      await fetchAccountLinkMetadata("https://gnusocial.jp/hongminhee"),
      { icon: "activitypub", "handle": "@hongminhee@gnusocial.jp" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://bsky.app/profile/hongminhee.org"),
      { icon: "bluesky", "handle": "@hongminhee.org" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://staging.bsky.app/profile/hongminhee.org",
      ),
      { icon: "bluesky", "handle": "@hongminhee.org" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://bsky.app/profile/did:plc:ia76kvnndjutgedggx2ibrem",
      ),
      { icon: "bluesky", "handle": "did:plc:ia76kvnndjutgedggx2ibrem" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://codeberg.org/hongminhee"),
      { icon: "codeberg", handle: "@hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://dev.to/hongminhee"),
      { icon: "dev", handle: "@hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://discord.com/users/533568224642465802",
      ),
      { icon: "discord" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://discordapp.com/users/533568224642465802",
      ),
      { icon: "discord" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://www.facebook.com/zuck"),
      { icon: "facebook", "handle": "zuck" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://www.facebook.com/profile.php?id=4",
      ),
      { icon: "facebook" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://github.com/dahlia"),
      { icon: "github", handle: "@dahlia" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://gitlab.com/hongminhee"),
      { icon: "gitlab", handle: "@hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://news.ycombinator.com/user?id=dahlia",
      ),
      { icon: "hackernews", handle: "dahlia" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://hollo.social/@hollo"),
      { icon: "hollo", handle: "@hollo@hollo.social" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://www.instagram.com/hong_minhee/"),
      { icon: "instagram", handle: "@hong_minhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://keybase.io/hongminhee"),
      { icon: "keybase", handle: "hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://lemmy.ml/u/hongminhee"),
      { icon: "lemmy", handle: "@hongminhee@lemmy.ml" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://www.linkedin.com/in/simnalamburt",
      ),
      { icon: "linkedin", handle: "simnalamburt" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://lobste.rs/~hongminhee"),
      { icon: "lobsters", handle: "~hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://fosstodon.org/@hongminhee"),
      { icon: "mastodon", handle: "@hongminhee@fosstodon.org" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://matrix.to/#/@hongminhee:matrix.org",
      ),
      { icon: "matrix", handle: "@hongminhee:matrix.org" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://matrix.to/#/#fedify-users:matrix.org",
      ),
      { icon: "matrix", handle: "#fedify-users:matrix.org" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://stella.place/@hongminhee"),
      { icon: "misskey", handle: "@hongminhee@stella.place" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://pxlmo.com/hongminhee"),
      { icon: "pixelfed", handle: "@hongminhee@pxlmo.com" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://stereophonic.space/users/karolat",
      ),
      { icon: "pleroma", handle: "@karolat@stereophonic.space" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://qiita.com/hongminhee"),
      { icon: "qiita", handle: "@hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://www.reddit.com/r/fediverse/"),
      { icon: "reddit", handle: "/r/fediverse" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://www.reddit.com/user/hongminhee/"),
      { icon: "reddit", handle: "/u/hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://sr.ht/~hongminhee/"),
      { icon: "sourcehut", handle: "~hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://www.threads.net/@hong_minhee"),
      { icon: "threads", handle: "@hong_minhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://velog.io/@hongminhee"),
      { icon: "velog", handle: "@hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://velog.io/@hongminhee/posts"),
      { icon: "velog", handle: "@hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://twitter.com/hongminhee"),
      { icon: "x", "handle": "@hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://en.wikipedia.org/wiki/User:Hongminhee",
      ),
      { icon: "wikipedia", "handle": "User:Hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://ko.wikipedia.org/wiki/%EC%82%AC%EC%9A%A9%EC%9E%90:Hongminhee",
      ),
      { icon: "wikipedia", "handle": "사용자:Hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://ja.wikipedia.org/wiki/%E5%88%A9%E7%94%A8%E8%80%85:Hongminhee",
      ),
      { icon: "wikipedia", "handle": "利用者:Hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://zh.wikipedia.org/wiki/User:Hongminhee",
      ),
      { icon: "wikipedia", "handle": "User:Hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://en.wikipedia.org/wiki/Donald_Knuth",
      ),
      { icon: "wikipedia", "handle": "Donald Knuth" },
    );
    assertEquals(
      await fetchAccountLinkMetadata(
        "https://ko.wikipedia.org/wiki/없는_페이지_7bb9e58313518a6772fb5b89e507acb4",
      ),
      { icon: "wikipedia" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://x.com/hongminhee"),
      { icon: "x", "handle": "@hongminhee" },
    );
    assertEquals(
      await fetchAccountLinkMetadata("https://zenn.dev/hongminhee"),
      { icon: "zenn", "handle": "@hongminhee" },
    );
  },
});
