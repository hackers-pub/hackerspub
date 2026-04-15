import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  getAvatarUrl,
  transformAvatar,
  updateAccountLinks,
  verifyAccountLink,
} from "./account.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";

let mockFetchLock: Promise<void> = Promise.resolve();

async function withMockFetch(
  handler: typeof globalThis.fetch,
  run: () => Promise<void>,
) {
  const previousLock = mockFetchLock;
  let releaseLock!: () => void;
  mockFetchLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
    releaseLock();
  }
}

test("getAvatarUrl() prefers stored avatars and falls back to gravatar defaults", async () => {
  const disk = {
    getUrl(key: string) {
      return Promise.resolve(`http://localhost/media/${key}`);
    },
  };

  const stored = await getAvatarUrl(disk as never, {
    avatarKey: "avatars/existing.webp",
    emails: [],
  } as never);
  assert.equal(stored, "http://localhost/media/avatars/existing.webp");

  const fallback = await getAvatarUrl(disk as never, {
    avatarKey: null,
    emails: [],
  } as never);
  assert.equal(fallback, "https://gravatar.com/avatar/?d=mp&s=128");
});

test("transformAvatar() crops rectangular images and preserves alpha via webp", async () => {
  const input = await sharp({
    create: {
      width: 200,
      height: 100,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 },
    },
  }).png().toBuffer();

  const { buffer, format } = await transformAvatar(input);

  assert.equal(format, "webp");
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 100);
  assert.equal(metadata.height, 100);
  assert.equal(metadata.format, "webp");
});

test("verifyAccountLink() recognizes rel=me links pointing at the profile URL", async () => {
  await withMockFetch(async () => {
    return new Response(
      `<html><head><link rel="me" href="https://hackers.pub/@alice"></head></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }, async () => {
    const verified = await verifyAccountLink(
      "https://example.com/profile",
      "https://hackers.pub/@alice",
    );
    assert.equal(verified, true);
  });
});

test("updateAccountLinks() stores ordered links with metadata and verification", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "accountlinksowner",
      name: "Account Links Owner",
      email: "accountlinksowner@example.com",
    });

    await withMockFetch(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
      return new Response(
        `<html><body><a rel="me" href="https://hackers.pub/@accountlinksowner">me</a>${url}</body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    }, async () => {
      const links = await updateAccountLinks(
        tx,
        account.account.id,
        "https://hackers.pub/@accountlinksowner",
        [
          { name: "GitHub", url: "https://github.com/dahlia" },
          { name: "Codeberg", url: "https://codeberg.org/hongminhee" },
        ],
      );

      assert.equal(links.length, 2);
      assert.deepEqual(
        links.map((link) => ({
          index: link.index,
          name: link.name,
          icon: link.icon,
          handle: link.handle,
          verified: link.verified != null,
        })),
        [
          {
            index: 0,
            name: "GitHub",
            icon: "github",
            handle: "@dahlia",
            verified: true,
          },
          {
            index: 1,
            name: "Codeberg",
            icon: "codeberg",
            handle: "@hongminhee",
            verified: true,
          },
        ],
      );
    });
  });
});
