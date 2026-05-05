import assert from "node:assert/strict";
import test from "node:test";
import * as vocab from "@fedify/vocab";
import sharp from "sharp";
import {
  createMediumFromBytes,
  createMediumFromUrl,
  persistPostMedium,
  UnsafeMediumUrlError,
} from "./medium.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withMockFetch,
  withRollback,
} from "../test/postgres.ts";

test("createMediumFromBytes() stores webp media once by content hash", async () => {
  await withRollback(async (tx) => {
    const putKeys: string[] = [];
    const disk = {
      put(key: string) {
        putKeys.push(key);
        return Promise.resolve();
      },
      getUrl(key: string) {
        return Promise.resolve(`http://localhost/media/${key}`);
      },
    };
    const input = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    }).png().toBuffer();

    const first = await createMediumFromBytes(tx, disk as never, input, {
      contentType: "image/png",
    });
    const second = await createMediumFromBytes(tx, disk as never, input, {
      contentType: "image/png",
    });

    assert.ok(first != null);
    assert.ok(second != null);
    assert.equal(second.id, first.id);
    assert.equal(first.type, "image/webp");
    assert.equal(first.width, 2);
    assert.equal(first.height, 2);
    assert.equal(putKeys.length, 1);
  });
});

test("createMediumFromUrl() rejects redirects to unsafe network targets", async () => {
  await withRollback(async (tx) => {
    const disk = {
      put() {
        return Promise.resolve();
      },
    };
    await withMockFetch((_input) => {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/image.png" },
        }),
      );
    }, async () => {
      await assert.rejects(
        () =>
          createMediumFromUrl(
            tx,
            disk as never,
            new URL("https://example.com/image.png"),
          ),
        UnsafeMediumUrlError,
      );
    });
  });
});

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
