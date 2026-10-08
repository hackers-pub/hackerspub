import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";
import * as vocab from "@fedify/vocab";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  createMediumFromBytes,
  createMediumFromUrl,
  persistPostMedium,
  UnsafeMediumUrlError,
} from "./medium.ts";
import { postTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withMockFetch,
  withRollback,
} from "../test/postgres.ts";

async function createTestVideo(
  format: "mp4" | "webm" = "mp4",
  audioFirst = false,
): Promise<Uint8Array<ArrayBuffer>> {
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=16x16:d=0.1",
      ...(audioFirst
        ? [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:duration=0.1",
            "-map",
            "1:a",
            "-map",
            "0:v",
            "-c:a",
            "aac",
          ]
        : []),
      "-c:v",
      format === "webm" ? "libvpx-vp9" : "mpeg4",
      "-f",
      format,
      ...(format === "mp4" ? ["-movflags", "frag_keyframe+empty_moov"] : []),
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  return new Uint8Array(stdout);
}

async function finishWithin<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Cancellation did not finish within five seconds."),
            ),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
    })
      .png()
      .toBuffer();

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
    await withMockFetch(
      (_input) => {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: "http://127.0.0.1/image.png" },
          }),
        );
      },
      async () => {
        await assert.rejects(
          () =>
            createMediumFromUrl(
              tx,
              disk as never,
              new URL("https://example.com/image.png"),
            ),
          UnsafeMediumUrlError,
        );
      },
    );
  });
});

test("createMediumFromUrl() stops reading remote bodies over the size limit", async () => {
  const disk = {
    put() {
      throw new Error("oversized media should not be stored");
    },
  };
  await withMockFetch(
    (_input) => {
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
    },
    async () => {
      const medium = await createMediumFromUrl(
        undefined as never,
        disk as never,
        new URL("https://example.com/image.png"),
        { maxSize: 4 },
      );

      assert.equal(medium, undefined);
    },
  );
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

    await withMockFetch(
      async () => {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      },
      async () => {
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
      },
    );
  });
});

test("persistPostMedium() ignores an attachment when its post disappears during fetch", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const account = await insertAccountWithActor(tx, {
      username: "deletedmediaowner",
      name: "Deleted Media Owner",
      email: "deletedmediaowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Deleted while downloading its attachment",
    });
    await withMockFetch(
      async () => {
        await tx.delete(postTable).where(eq(postTable.id, post.id));
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "image/png" },
        });
      },
      async () => {
        assert.equal(
          await persistPostMedium(
            fedCtx,
            new vocab.Image({
              url: new URL("https://remote.example/deleted.png"),
            }),
            post.id,
            0,
          ),
          undefined,
        );
        assert.equal(
          await tx.query.postMediumTable.findFirst({
            where: { postId: post.id },
          }),
          undefined,
        );
      },
    );
  });
});

test("persistPostMedium() removes an unused video thumbnail after post deletion", async (t) => {
  const video = await createTestVideo();
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const account = await insertAccountWithActor(tx, {
      username: "deletedvideoowner",
      name: "Deleted Video Owner",
      email: "deletedvideoowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Deleted while downloading its video",
    });
    const puts = t.mock.method(fedCtx.storage, "put");
    const deletes = t.mock.method(fedCtx.storage, "delete");
    await withMockFetch(
      async () => {
        await tx.delete(postTable).where(eq(postTable.id, post.id));
        return new Response(video, {
          headers: { "Content-Type": "video/mp4" },
        });
      },
      async () => {
        assert.equal(
          await persistPostMedium(
            fedCtx,
            new vocab.Video({
              url: new URL("https://remote.example/deleted.mp4"),
            }),
            post.id,
            0,
          ),
          undefined,
        );
        assert.equal(puts.mock.callCount(), 1);
        assert.equal(deletes.mock.callCount(), 1);
        const key = puts.mock.calls[0].arguments[0];
        assert.equal(deletes.mock.calls[0].arguments[0], key);
        await assert.rejects(async () => fedCtx.storage.getBytes(key));
      },
    );
  });
});

for (const mediaType of [
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const) {
  test(`persistPostMedium() decodes ${mediaType} dimensions and thumbnails`, async () => {
    const video = await createTestVideo(
      mediaType === "video/webm" ? "webm" : "mp4",
      mediaType === "video/mp4",
    );
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "decodedvideoowner",
        name: "Decoded Video Owner",
        email: "decodedvideoowner@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: account.account,
        content: "A video attachment",
      });
      const fedCtx = createFedCtx(tx);
      await withMockFetch(
        async () =>
          new Response(video, { headers: { "Content-Type": mediaType } }),
        async () => {
          const medium = await persistPostMedium(
            fedCtx,
            new vocab.Video({
              url: new URL("https://remote.example/video"),
              mediaType,
            }),
            post.id,
            0,
          );
          assert.ok(medium != null && medium.thumbnailKey != null);
          assert.equal(medium.type, mediaType);
          assert.equal(medium.width, 16);
          assert.equal(medium.height, 16);
          const metadata = await sharp(
            await fedCtx.storage.getBytes(medium.thumbnailKey),
          ).metadata();
          assert.equal(metadata.format, "png");
          assert.equal(metadata.width, 16);
          assert.equal(metadata.height, 16);
        },
      );
    });
  });
}

test("persistPostMedium() cancels stalled video bodies when its budget expires", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      streamController = value;
      value.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  await withMockFetch(
    async () => {
      started.resolve();
      return new Response(body, { headers: { "Content-Type": "video/mp4" } });
    },
    async () => {
      const pending = persistPostMedium(
        createFedCtx(undefined as never),
        new vocab.Video({
          url: new URL("https://remote.example/stalled.mp4"),
          width: 640,
          height: 480,
        }),
        crypto.randomUUID() as never,
        0,
        { signal: controller.signal },
      );
      await started.promise;
      controller.abort();
      try {
        assert.equal(await finishWithin(pending), undefined);
        assert.equal(cancelled, true);
      } finally {
        if (!cancelled) streamController!.close();
        await pending;
      }
    },
  );
});

for (const binary of ["FFPROBE_PATH", "FFMPEG_PATH"] as const) {
  test(`persistPostMedium() kills a stalled ${binary} process`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "hackerspub-process-test-"));
    const executable = join(directory, "stalled.mjs");
    const marker = join(directory, "pid");
    const previous = process.env[binary];
    const controller = new AbortController();
    let pending: ReturnType<typeof persistPostMedium> | undefined;
    try {
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      process.env[binary] = executable;
      await withMockFetch(
        async () =>
          new Response(new Uint8Array([1]), {
            headers: { "Content-Type": "video/mp4" },
          }),
        async () => {
          pending = persistPostMedium(
            createFedCtx(undefined as never),
            new vocab.Video({
              url: new URL("https://remote.example/stalled-process.mp4"),
              ...(binary === "FFMPEG_PATH" ? { width: 16, height: 16 } : {}),
            }),
            crypto.randomUUID() as never,
            0,
            { signal: controller.signal },
          );
          let pid: number | undefined;
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              pid = Number(await readFile(marker, "utf8"));
              break;
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(pid != null, "media process should start");
          controller.abort();
          assert.equal(await pending, undefined);
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        },
      );
    } finally {
      controller.abort();
      await pending;
      if (previous == null) delete process.env[binary];
      else process.env[binary] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const binary of ["FFPROBE_PATH", "FFMPEG_PATH"] as const) {
  test(`persistPostMedium() skips videos when ${binary} is unavailable`, async () => {
    const previous = process.env[binary];
    process.env[binary] = join(
      tmpdir(),
      `missing-media-binary-${crypto.randomUUID()}`,
    );
    try {
      await withMockFetch(
        async () =>
          new Response(new Uint8Array([1]), {
            headers: { "Content-Type": "video/mp4" },
          }),
        async () => {
          assert.equal(
            await persistPostMedium(
              createFedCtx(undefined as never),
              new vocab.Video({
                url: new URL("https://remote.example/missing-process.mp4"),
                ...(binary === "FFMPEG_PATH" ? { width: 16, height: 16 } : {}),
              }),
              crypto.randomUUID() as never,
              0,
            ),
            undefined,
          );
        },
      );
    } finally {
      if (previous == null) delete process.env[binary];
      else process.env[binary] = previous;
    }
  });
}

test("persistPostMedium() skips a video that produces no thumbnail frame", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "hackerspub-empty-video-test-"),
  );
  const executable = join(directory, "empty.mjs");
  const previous = process.env.FFMPEG_PATH;
  try {
    await writeFile(executable, "#!/usr/bin/env node\n", { mode: 0o755 });
    process.env.FFMPEG_PATH = executable;
    await withMockFetch(
      async () =>
        new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "video/mp4" },
        }),
      async () => {
        assert.equal(
          await persistPostMedium(
            createFedCtx(undefined as never),
            new vocab.Video({
              url: new URL("https://remote.example/empty-frame.mp4"),
              width: 16,
              height: 16,
            }),
            crypto.randomUUID() as never,
            0,
          ),
          undefined,
        );
      },
    );
  } finally {
    if (previous == null) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistPostMedium() preserves storage failures after video processing", async (t) => {
  const video = await createTestVideo();
  const fedCtx = createFedCtx(undefined as never);
  const failure = new Error("storage unavailable");
  t.mock.method(fedCtx.storage, "put", async () => {
    throw failure;
  });
  await withMockFetch(
    async () =>
      new Response(video, { headers: { "Content-Type": "video/mp4" } }),
    async () => {
      await assert.rejects(
        persistPostMedium(
          fedCtx,
          new vocab.Video({
            url: new URL("https://remote.example/storage-failure.mp4"),
          }),
          crypto.randomUUID() as never,
          0,
        ),
        (error) => error === failure,
      );
    },
  );
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

    await withMockFetch(
      async () => {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      },
      async () => {
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
      },
    );
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

    await withMockFetch(
      async () => {
        return new Response("<!doctype html><title>Blocked</title>", {
          status: 403,
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      },
      async () => {
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
      },
    );
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

    await withMockFetch(
      async () => {
        throw new TypeError("DNS lookup failed");
      },
      async () => {
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
      },
    );
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

    await withMockFetch(
      async () => {
        return new Response("<!doctype html><title>Not a video</title>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      },
      async () => {
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
      },
    );
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
