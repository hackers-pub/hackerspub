import assert from "node:assert";
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

test("createMediumFromBytes() stores animated image frame height", async () => {
  await withRollback(async (tx) => {
    const disk = {
      put() {
        return Promise.resolve();
      },
      getUrl(key: string) {
        return Promise.resolve(`http://localhost/media/${key}`);
      },
    };
    const input = Uint8Array.from(
      atob(
        "R0lGODlhAwACAPAAAP8AAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAwACAAACAoRfACH5BAAKAAAALAAAAAADAAIAgAAA/////wIChF8AOw==",
      ),
      (char) => char.charCodeAt(0),
    );

    const medium = await createMediumFromBytes(tx, disk as never, input, {
      contentType: "image/gif",
    });

    assert.ok(medium != null);
    assert.equal(medium.type, "image/webp");
    assert.equal(medium.width, 3);
    assert.equal(medium.height, 2);
  });
});

test("createMediumFromBytes() rejects corrupt image bytes", async () => {
  const medium = await createMediumFromBytes(
    undefined as never,
    undefined as never,
    new Uint8Array([1, 2, 3, 4]),
    { contentType: "image/png" },
  );

  assert.equal(medium, undefined);
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

test("createMediumFromUrl() stops reading remote bodies over the size limit", async () => {
  const disk = {
    put() {
      throw new Error("oversized media should not be stored");
    },
  };
  await withMockFetch((_input) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5]));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
  }, async () => {
    const medium = await createMediumFromUrl(
      undefined as never,
      disk as never,
      new URL("https://example.com/image.png"),
      { maxSize: 4 },
    );

    assert.equal(medium, undefined);
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

test("persistPostMedium() updates an existing attachment index", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const account = await insertAccountWithActor(tx, {
      username: "updatemediaowner",
      name: "Update Media Owner",
      email: "updatemediaowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Post with updated media",
    });

    await withMockFetch(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }, async () => {
      await persistPostMedium(
        fedCtx,
        new vocab.Image({
          url: new URL("https://remote.example/media/original.png"),
          name: "Original alt",
          width: 640,
          height: 480,
        }),
        post.id,
        0,
      );
      const updated = await persistPostMedium(
        fedCtx,
        new vocab.Image({
          url: new URL("https://remote.example/media/updated.png"),
          name: "Updated alt",
          width: 800,
          height: 600,
        }),
        post.id,
        0,
      );

      assert.ok(updated != null);
      assert.equal(updated.postId, post.id);
      assert.equal(updated.index, 0);
      assert.equal(updated.url, "https://remote.example/media/updated.png");
      assert.equal(updated.alt, "Updated alt");
      assert.equal(updated.width, 800);
      assert.equal(updated.height, 600);

      const media = await tx.query.postMediumTable.findMany({
        where: { postId: post.id },
      });
      assert.equal(media.length, 1);
    });
  });
});

test("persistPostMedium() ignores failed remote video responses", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const account = await insertAccountWithActor(tx, {
      username: "failedvideoowner",
      name: "Failed Video Owner",
      email: "failedvideoowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Post with failed video",
    });

    await withMockFetch(async () => {
      return new Response("<!doctype html><title>Blocked</title>", {
        status: 403,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }, async () => {
      const medium = await persistPostMedium(
        fedCtx,
        new vocab.Video({
          url: new URL("https://remote.example/media/blocked.mp4"),
          mediaType: "video/mp4",
        }),
        post.id,
        0,
      );

      assert.equal(medium, undefined);
    });
  });
});

test("persistPostMedium() ignores remote transport failures", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const account = await insertAccountWithActor(tx, {
      username: "unreachablemediaowner",
      name: "Unreachable Media Owner",
      email: "unreachablemediaowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Post with unreachable media",
    });

    await withMockFetch(async () => {
      throw new TypeError("DNS lookup failed");
    }, async () => {
      const medium = await persistPostMedium(
        fedCtx,
        new vocab.Image({
          url: new URL("https://unreachable.example/media/image.png"),
          mediaType: "image/png",
        }),
        post.id,
        0,
      );

      assert.equal(medium, undefined);
    });
  });
});

test("persistPostMedium() ignores non-media remote video responses", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const account = await insertAccountWithActor(tx, {
      username: "htmlvideoowner",
      name: "HTML Video Owner",
      email: "htmlvideoowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Post with HTML video response",
    });

    await withMockFetch(async () => {
      return new Response("<!doctype html><title>Not a video</title>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }, async () => {
      const medium = await persistPostMedium(
        fedCtx,
        new vocab.Video({
          url: new URL("https://remote.example/media/not-video.mp4"),
          mediaType: "video/mp4",
        }),
        post.id,
        0,
      );

      assert.equal(medium, undefined);
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
