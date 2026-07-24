import assert from "node:assert";
import { createServer } from "node:http";
import test from "node:test";
import type { Disk } from "flydrive";
import sharp from "sharp";
import {
  loadImageDataUri,
  putArticleOgImage,
  putProfileOgImage,
  truncateText,
} from "./og.ts";

const smallPngDataUrl =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const smallPngBytes = Uint8Array.from(
  atob(smallPngDataUrl.slice("data:image/png;base64,".length)),
  (char) => char.charCodeAt(0),
);

async function serve(
  optionsOrHandler:
    | { hostname: string; port: number; onListen(): void }
    | ((request: Request) => Response | Promise<Response>),
  optionalHandler?: (request: Request) => Response | Promise<Response>,
) {
  const handler =
    typeof optionsOrHandler === "function" ? optionsOrHandler : optionalHandler;
  if (handler == null) throw new Error("A request handler is required.");
  const server = createServer(async (request, response) => {
    try {
      const result = await handler(
        new Request(`http://127.0.0.1${request.url ?? "/"}`),
      );
      response.writeHead(
        result.status,
        Object.fromEntries(result.headers.entries()),
      );
      if (result.body == null) {
        response.end();
      } else {
        response.end(new Uint8Array(await result.arrayBuffer()));
      }
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Failed to resolve the local test server address.");
  }
  return {
    addr: { hostname: address.address, port: address.port },
    shutdown: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error == null ? resolve() : reject(error)));
      }),
  };
}

function createOgTestDisk() {
  const putKeys: string[] = [];
  return {
    putKeys,
    disk: {
      put(key: string) {
        putKeys.push(key);
        return Promise.resolve(undefined);
      },
    } as unknown as Disk,
  };
}

test("truncateText preserves grapheme clusters", () => {
  assert.equal(truncateText("Flags 👩‍💻👩‍💻", 7), "Flags…");
  assert.equal(truncateText("Cafe\u0301 au lait", 6), "Cafe\u0301…");
});

test("loadImageDataUri returns data URIs unchanged", async () => {
  assert.equal(await loadImageDataUri(smallPngDataUrl), smallPngDataUrl);
});

test("loadImageDataUri embeds remote images", async () => {
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response(smallPngBytes, {
        headers: { "content-type": "image/png" },
      }),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.png`;
    assert.equal(await loadImageDataUri(url), smallPngDataUrl);
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri transcodes WEBP responses to PNG", async () => {
  const webpBytes = new Uint8Array(
    await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .webp()
      .toBuffer(),
  );
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response(webpBytes, {
        headers: { "content-type": "image/webp" },
      }),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.webp`;
    const result = await loadImageDataUri(url);
    const prefix = "data:image/png;base64,";
    assert.ok(result.startsWith(prefix));
    const decoded = Uint8Array.from(atob(result.slice(prefix.length)), (char) =>
      char.charCodeAt(0),
    );
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert.deepEqual(
      Array.from(decoded.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri preserves APNG responses", async () => {
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response(smallPngBytes, {
        headers: { "content-type": "image/apng" },
      }),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.png`;
    assert.equal(
      await loadImageDataUri(url),
      `data:image/apng;base64,${smallPngDataUrl.slice(
        "data:image/png;base64,".length,
      )}`,
    );
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri falls back when transcoded output exceeds maxBytes", async () => {
  const noise = new Uint8Array(128 * 128 * 4);
  crypto.getRandomValues(noise);
  const webpBytes = new Uint8Array(
    await sharp(noise, {
      raw: { width: 128, height: 128, channels: 4 },
    })
      .webp({ quality: 30 })
      .toBuffer(),
  );
  // Lossy WebP compresses random noise far better than the lossless PNG
  // we re-encode it into, so a budget that admits the WebP still rejects
  // the PNG and exercises the post-transcode size guard.
  const maxBytes = webpBytes.byteLength + 256;
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response(webpBytes, {
        headers: { "content-type": "image/webp" },
      }),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.webp`;
    assert.equal(await loadImageDataUri(url, { maxBytes }), smallPngDataUrl);
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri falls back when transcoding fails", async () => {
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response(Uint8Array.from([0, 1, 2, 3]), {
        headers: { "content-type": "image/webp" },
      }),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.webp`;
    assert.equal(await loadImageDataUri(url), smallPngDataUrl);
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri rejects non-image responses", async () => {
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response("not an image", {
        headers: { "content-type": "text/plain" },
      }),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.txt`;
    assert.equal(await loadImageDataUri(url), smallPngDataUrl);
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri falls back when image responses have no body", async () => {
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response(null, {
        headers: { "content-type": "image/png" },
      }),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.png`;
    assert.equal(await loadImageDataUri(url), smallPngDataUrl);
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri rejects unsupported URL schemes", async () => {
  assert.equal(
    await loadImageDataUri("file:///tmp/avatar.png"),
    smallPngDataUrl,
  );
});

test("loadImageDataUri falls back when remote images are too large", async () => {
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": "image/png", "content-length": "3" },
      }),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.png`;
    assert.equal(await loadImageDataUri(url, { maxBytes: 2 }), smallPngDataUrl);
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri falls back when streamed images are too large", async () => {
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2]));
            controller.enqueue(Uint8Array.from([3]));
            controller.close();
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.png`;
    assert.equal(await loadImageDataUri(url, { maxBytes: 2 }), smallPngDataUrl);
  } finally {
    await server.shutdown();
  }
});

test("loadImageDataUri falls back when remote images time out", async () => {
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(smallPngBytes, {
        headers: { "content-type": "image/png" },
      });
    },
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.png`;
    assert.equal(
      await loadImageDataUri(url, { timeoutMs: 1 }),
      smallPngDataUrl,
    );
  } finally {
    await server.shutdown();
  }
});

test("putProfileOgImage skips image fetches on cache hits", async () => {
  const { disk, putKeys } = createOgTestDisk();
  const input = {
    avatarKey: "avatar/profile.png",
    avatarUrl: smallPngDataUrl,
    bio: "Cached profile OG",
    displayName: "Cached Profile",
    handle: "@cached@localhost",
  };
  const key = await putProfileOgImage(disk, null, input);
  let requests = 0;
  const server = await serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    },
    () => {
      requests++;
      return new Response(smallPngBytes, {
        headers: { "content-type": "image/png" },
      });
    },
  );
  try {
    const url = `http://${server.addr.hostname}:${server.addr.port}/avatar.png`;
    assert.equal(
      await putProfileOgImage(disk, key, { ...input, avatarUrl: url }),
      key,
    );
    assert.equal(requests, 0);
    assert.equal(putKeys.length, 1);
  } finally {
    await server.shutdown();
  }
});

test("putProfileOgImage keys avatars by stable identity", async () => {
  const { disk, putKeys } = createOgTestDisk();
  const input = {
    avatarKey: "avatar/profile.png",
    avatarUrl: smallPngDataUrl,
    bio: "Stable avatar cache identity",
    displayName: "Stable Profile",
    handle: "@stable@localhost",
  };

  const firstKey = await putProfileOgImage(disk, null, input);
  const secondKey = await putProfileOgImage(disk, firstKey, {
    ...input,
    avatarUrl: "https://example.com/avatar.png?signature=changed",
  });

  assert.equal(secondKey, firstKey);
  assert.equal(putKeys.length, 1);
});

test("putArticleOgImage keys avatars by stable identity", async () => {
  const { disk, putKeys } = createOgTestDisk();
  const input = {
    authorName: "Stable Author",
    avatarKey: "avatar/article.png",
    avatarUrl: smallPngDataUrl,
    excerpt: "Stable article avatar cache identity",
    handle: "@stable@localhost",
    language: "en",
    sourceId: "019de14c-1ef2-7728-99a8-60efa271a111",
    title: "Stable article",
  };

  const firstKey = await putArticleOgImage(disk, null, input);
  const secondKey = await putArticleOgImage(disk, firstKey, {
    ...input,
    avatarUrl: "https://example.com/avatar.png?signature=changed",
  });

  assert.equal(secondKey, firstKey);
  assert.equal(putKeys.length, 1);
});
