import assert from "node:assert/strict";
import test from "node:test";
import * as vocab from "@fedify/vocab";
import { persistPostMedium } from "./medium.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

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

test("persistPostMedium() stores image attachments and infers media type from content-type", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const account = await insertAccountWithActor(tx, {
      username: "mediapostowner",
      name: "Media Post Owner",
      email: "mediapostowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Post with media",
    });

    await withMockFetch(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }, async () => {
      const medium = await persistPostMedium(
        fedCtx,
        new vocab.Image({
          url: new URL("https://remote.example/media/no-extension"),
          name: "Alt text",
          width: 640,
          height: 480,
        }),
        post.id,
        0,
      );

      assert.ok(medium != null);
      assert.equal(medium.postId, post.id);
      assert.equal(medium.index, 0);
      assert.equal(medium.type, "image/png");
      assert.equal(medium.alt, "Alt text");
      assert.equal(medium.width, 640);
      assert.equal(medium.height, 480);
    });
  });
});

test("persistPostMedium() ignores unsupported non-image documents", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const account = await insertAccountWithActor(tx, {
      username: "unsupportedmediaowner",
      name: "Unsupported Media Owner",
      email: "unsupportedmediaowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Unsupported media post",
    });

    const medium = await persistPostMedium(
      fedCtx,
      new vocab.Document({
        url: new URL("https://remote.example/archive.zip"),
        mediaType: "application/zip",
      }),
      post.id,
      0,
    );

    assert.equal(medium, undefined);
  });
});
