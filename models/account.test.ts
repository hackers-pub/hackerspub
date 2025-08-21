import { assertEquals } from "@std/assert/equals";
import { assertThrows } from "@std/assert/throws";
import {
  fetchAccountLinkMetadata,
  type LinkMetadata,
  normalizeEmail,
} from "./account.ts";

const linkMetadata: Record<string, LinkMetadata> = {
  "https://fedibird.com/@hongminhee": {
    icon: "activitypub",
    "handle": "@hongminhee@fedibird.com",
  },
  "https://bsky.app/profile/hongminhee.org": {
    icon: "bluesky",
    "handle": "@hongminhee.org",
  },
  "https://staging.bsky.app/profile/hongminhee.org": {
    icon: "bluesky",
    "handle": "@hongminhee.org",
  },
  "https://bsky.app/profile/did:plc:ia76kvnndjutgedggx2ibrem": {
    icon: "bluesky",
    "handle": "did:plc:ia76kvnndjutgedggx2ibrem",
  },
  "https://codeberg.org/hongminhee": {
    icon: "codeberg",
    handle: "@hongminhee",
  },
  "https://dev.to/hongminhee": { icon: "dev", handle: "@hongminhee" },
  "https://discord.com/users/533568224642465802": { icon: "discord" },
  "https://discordapp.com/users/533568224642465802": { icon: "discord" },
  "https://www.facebook.com/zuck": { icon: "facebook", "handle": "zuck" },
  "https://www.facebook.com/profile.php?id=4": { icon: "facebook" },
  "https://github.com/dahlia": { icon: "github", handle: "@dahlia" },
  "https://gitlab.com/hongminhee": { icon: "gitlab", handle: "@hongminhee" },
  "https://news.ycombinator.com/user?id=dahlia": {
    icon: "hackernews",
    handle: "dahlia",
  },
  "https://hollo.social/@hollo": {
    icon: "hollo",
    handle: "@hollo@hollo.social",
  },
  "https://www.instagram.com/hong_minhee/": {
    icon: "instagram",
    handle: "@hong_minhee",
  },
  "https://keybase.io/hongminhee": { icon: "keybase", handle: "hongminhee" },
  "https://lemmy.ml/u/hongminhee": {
    icon: "lemmy",
    handle: "@hongminhee@lemmy.ml",
  },
  "https://www.linkedin.com/in/simnalamburt": {
    icon: "linkedin",
    handle: "simnalamburt",
  },
  "https://lobste.rs/~hongminhee": { icon: "lobsters", handle: "~hongminhee" },
  "https://fosstodon.org/@hongminhee": {
    icon: "mastodon",
    handle: "@hongminhee@fosstodon.org",
  },
  "https://matrix.to/#/@hongminhee:matrix.org": {
    icon: "matrix",
    handle: "@hongminhee:matrix.org",
  },
  "https://matrix.to/#/#fedify-users:matrix.org": {
    icon: "matrix",
    handle: "#fedify-users:matrix.org",
  },
  "https://hoto.moe/@hongminhee": {
    icon: "misskey",
    handle: "@hongminhee@hoto.moe",
  },
  "https://pixelfed.social/dansup": {
    icon: "pixelfed",
    handle: "@dansup@pixelfed.social",
  },
  "https://stereophonic.space/users/karolat": {
    icon: "pleroma",
    handle: "@karolat@stereophonic.space",
  },
  "https://qiita.com/hongminhee": { icon: "qiita", handle: "@hongminhee" },
  "https://www.reddit.com/r/fediverse/": {
    icon: "reddit",
    handle: "/r/fediverse",
  },
  "https://www.reddit.com/user/hongminhee/": {
    icon: "reddit",
    handle: "/u/hongminhee",
  },
  "https://sr.ht/~hongminhee/": { icon: "sourcehut", handle: "~hongminhee" },
  "https://www.threads.net/@hong_minhee": {
    icon: "threads",
    handle: "@hong_minhee",
  },
  "https://velog.io/@hongminhee": { icon: "velog", handle: "@hongminhee" },
  "https://velog.io/@hongminhee/posts": {
    icon: "velog",
    handle: "@hongminhee",
  },
  "https://twitter.com/hongminhee": { icon: "x", "handle": "@hongminhee" },
  "https://x.com/hongminhee": { icon: "x", "handle": "@hongminhee" },
  "https://en.wikipedia.org/wiki/User:Hongminhee": {
    icon: "wikipedia",
    "handle": "User:Hongminhee",
  },
  "https://ko.wikipedia.org/wiki/%EC%82%AC%EC%9A%A9%EC%9E%90:Hongminhee": {
    icon: "wikipedia",
    "handle": "사용자:Hongminhee",
  },
  "https://ja.wikipedia.org/wiki/%E5%88%A9%E7%94%A8%E8%80%85:Hongminhee": {
    icon: "wikipedia",
    "handle": "利用者:Hongminhee",
  },
  "https://zh.wikipedia.org/wiki/User:Hongminhee": {
    icon: "wikipedia",
    "handle": "User:Hongminhee",
  },
  "https://en.wikipedia.org/wiki/Donald_Knuth": {
    icon: "wikipedia",
    "handle": "Donald Knuth",
  },
  "https://ko.wikipedia.org/wiki/없는_페이지_7bb9e58313518a6772fb5b89e507acb4":
    { icon: "wikipedia" },
  "https://zenn.dev/hongminhee": { icon: "zenn", "handle": "@hongminhee" },
};

for (const url in linkMetadata) {
  const metadata = linkMetadata[url];
  Deno.test({
    name: `fetchAccountLinkMetadata(${JSON.stringify(url)})`,
    sanitizeResources: false,
    async fn() {
      assertEquals(
        await fetchAccountLinkMetadata(url),
        metadata,
      );
    },
  });
}

Deno.test("normalizeEmail()", async (t) => {
  await t.step("with valid email", () => {
    assertEquals(normalizeEmail("test@example.com"), "test@example.com");
    assertEquals(normalizeEmail("  test@example.com  "), "test@example.com");
    assertEquals(normalizeEmail("Test@EXAMPLE.COM"), "Test@example.com");
    assertEquals(
      normalizeEmail("user@中文.example"),
      "user@xn--fiq228c.example",
    );
  });

  await t.step("with null and undefined", () => {
    assertEquals(normalizeEmail(null), null);
    assertEquals(normalizeEmail(undefined), undefined);
  });

  await t.step("with invalid email", () => {
    assertThrows(
      () => normalizeEmail("invalid"),
      TypeError,
      "Invalid email format.",
    );
    assertThrows(
      () => normalizeEmail("@example.com"),
      TypeError,
      "Invalid email format.",
    );
    assertThrows(
      () => normalizeEmail("test@"),
      TypeError,
      "Invalid email format.",
    );
    assertThrows(
      () => normalizeEmail("test@example@com"),
      TypeError,
      "Invalid email format.",
    );
  });
});
