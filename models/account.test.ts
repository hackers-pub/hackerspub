import assert from "node:assert/strict";
import test from "node:test";
import { describe, it } from "node:test";
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
  "https://misskey.io/@hongminhee": {
    icon: "misskey",
    handle: "@hongminhee@misskey.io",
  },
  "https://pixelfed.social/dansup": {
    icon: "pixelfed",
    handle: "@dansup@pixelfed.social",
  },
  "https://stereophonic.space/users/hongminhee": {
    icon: "pleroma",
    handle: "@hongminhee@stereophonic.space",
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
  test(`fetchAccountLinkMetadata(${JSON.stringify(url)})`, async () => {
    assert.deepEqual(
      await fetchAccountLinkMetadata(url),
      metadata,
    );
  });
}

describe("normalizeEmail()", () => {
  it("with valid email", () => {
    assert.deepEqual(normalizeEmail("test@example.com"), "test@example.com");
    assert.deepEqual(
      normalizeEmail("  test@example.com  "),
      "test@example.com",
    );
    assert.deepEqual(normalizeEmail("Test@EXAMPLE.COM"), "Test@example.com");
    assert.deepEqual(
      normalizeEmail("user@中文.example"),
      "user@xn--fiq228c.example",
    );
  });

  it("with null and undefined", () => {
    assert.deepEqual(normalizeEmail(null), null);
    assert.deepEqual(normalizeEmail(undefined), undefined);
  });

  it("with invalid email", () => {
    assert.throws(
      () => normalizeEmail("invalid"),
      (e) =>
        e instanceof TypeError && e.message.includes("Invalid email format."),
    );
    assert.throws(
      () => normalizeEmail("@example.com"),
      (e) =>
        e instanceof TypeError && e.message.includes("Invalid email format."),
    );
    assert.throws(
      () => normalizeEmail("test@"),
      (e) =>
        e instanceof TypeError && e.message.includes("Invalid email format."),
    );
    assert.throws(
      () => normalizeEmail("test@example@com"),
      (e) =>
        e instanceof TypeError && e.message.includes("Invalid email format."),
    );
  });
});
