import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDriveResource } from "@hackerspub/runtime/resources";
import { pathToFileURL } from "node:url";
import { handleFileSystemMedia } from "./file-system-media.ts";

test("handleFileSystemMedia serves filesystem media", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-media-"));
  try {
    await writeFile(join(directory, "hello.txt"), "hello world");
    const root = pathToFileURL(directory + "/");

    const response = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt"),
      root,
    );

    assert.equal(response?.status, 200);
    assert.equal(
      response?.headers.get("content-type"),
      "text/plain; charset=UTF-8",
    );
    assert.equal(await response?.text(), "hello world");

    const head = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt", { method: "HEAD" }),
      root,
    );
    assert.equal(head?.status, 200);
    assert.equal(await head?.text(), "");

    const rangedHead = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt", {
        method: "HEAD",
        headers: { range: "bytes=0-4" },
      }),
      root,
    );
    assert.equal(rangedHead?.status, 200);
    assert.equal(rangedHead?.headers.get("content-length"), "11");
    assert.equal(rangedHead?.headers.get("content-range"), null);

    const range = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt", {
        headers: { range: "bytes=0-4" },
      }),
      root,
    );
    assert.equal(range?.status, 206);
    assert.equal(await range?.text(), "hello");

    const suffixRange = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt", {
        headers: { range: "bytes=-5" },
      }),
      root,
    );
    assert.equal(suffixRange?.status, 206);
    assert.equal(await suffixRange?.text(), "world");

    for (const unsupportedRange of ["bytes=0-1,3-4", "nonsense"]) {
      const fullResponse = await handleFileSystemMedia(
        new Request("https://example.com/media/hello.txt", {
          headers: { range: unsupportedRange },
        }),
        root,
      );
      assert.equal(fullResponse?.status, 200);
      assert.equal(fullResponse?.headers.get("content-length"), "11");
      assert.equal(fullResponse?.headers.get("content-range"), null);
      assert.equal(await fullResponse?.text(), "hello world");
    }

    const invalidRange = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt", {
        headers: { range: "bytes=99-100" },
      }),
      root,
    );
    assert.equal(invalidRange?.status, 416);
    assert.equal(invalidRange?.headers.get("content-range"), "bytes */11");

    const missing = await handleFileSystemMedia(
      new Request("https://example.com/media/missing.txt"),
      root,
    );
    assert.equal(missing?.status, 404);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("handleFileSystemMedia honors cache validators", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-media-"));
  try {
    await writeFile(join(directory, "hello.txt"), "hello world");
    const root = pathToFileURL(directory + "/");
    const url = "https://example.com/media/hello.txt";
    const initial = await handleFileSystemMedia(new Request(url), root);
    const etag = initial?.headers.get("etag");
    const lastModified = initial?.headers.get("last-modified");
    assert.ok(etag);
    assert.ok(lastModified);

    for (const [name, value] of [
      ["If-None-Match", etag],
      ["If-Modified-Since", lastModified],
    ] as const) {
      const response = await handleFileSystemMedia(
        new Request(url, { headers: { [name]: value } }),
        root,
      );
      assert.equal(response?.status, 304);
      assert.equal(await response?.text(), "");
      assert.equal(response?.headers.get("etag"), etag);
      assert.equal(response?.headers.get("last-modified"), lastModified);
      assert.equal(response?.headers.get("content-length"), null);
    }

    const precedence = await handleFileSystemMedia(
      new Request(url, {
        headers: {
          "If-None-Match": '"different"',
          "If-Modified-Since": lastModified,
        },
      }),
      root,
    );
    assert.equal(precedence?.status, 200);
    assert.equal(await precedence?.text(), "hello world");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("handleFileSystemMedia ignores non-media and prevents traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-media-"));
  try {
    const root = pathToFileURL(directory + "/");
    assert.equal(
      await handleFileSystemMedia(
        new Request("https://example.com/graphql"),
        root,
      ),
      null,
    );
    assert.equal(
      await handleFileSystemMedia(
        new Request("https://example.com/media/%2e%2e/secret.txt"),
        root,
      ),
      null,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("handleFileSystemMedia rejects hidden path segments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-media-"));
  try {
    await writeFile(join(directory, ".secret"), "secret");
    await mkdir(join(directory, "nested", ".git"), { recursive: true });
    await writeFile(join(directory, "nested", ".git", "config"), "secret");
    const root = pathToFileURL(directory + "/");

    for (const path of [".secret", "nested/%2Egit/config"]) {
      const response = await handleFileSystemMedia(
        new Request(`https://example.com/media/${path}`),
        root,
      );
      assert.equal(response?.status, 404);
      assert.equal(await response?.text(), "Not Found");
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("handleFileSystemMedia serves files written by a separate drive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-media-"));
  try {
    const drive = createDriveResource(
      { driver: "fs", location: "./media" },
      new URL("https://example.com/"),
      pathToFileURL(directory + "/"),
    );
    await drive
      .use()
      .put("remote/attachment.txt", new TextEncoder().encode("from worker"));

    const response = await handleFileSystemMedia(
      new Request("https://example.com/media/remote/attachment.txt"),
      drive.fileSystemRoot,
    );

    assert.equal(response?.status, 200);
    assert.equal(await response?.text(), "from worker");
  } finally {
    await rm(directory, { recursive: true });
  }
});
