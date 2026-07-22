import assert from "node:assert";
import test from "node:test";
import { createDriveResource } from "@hackerspub/runtime/resources";
import { pathToFileURL } from "node:url";
import { handleFileSystemMedia } from "./file-system-media.ts";

test("handleFileSystemMedia serves filesystem media", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${directory}/hello.txt`, "hello world");
    const root = pathToFileURL(directory + "/");

    const response = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt"),
      root,
    );

    assert.equal(response?.status, 200);
    assert.equal(await response?.text(), "hello world");

    const head = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt", { method: "HEAD" }),
      root,
    );
    assert.equal(head?.status, 200);
    assert.equal(await head?.text(), "");

    const range = await handleFileSystemMedia(
      new Request("https://example.com/media/hello.txt", {
        headers: { range: "bytes=0-4" },
      }),
      root,
    );
    assert.equal(range?.status, 206);
    assert.equal(await range?.text(), "hello");

    const missing = await handleFileSystemMedia(
      new Request("https://example.com/media/missing.txt"),
      root,
    );
    assert.equal(missing?.status, 404);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

test("handleFileSystemMedia ignores non-media and prevents traversal", async () => {
  const directory = await Deno.makeTempDir();
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
    await Deno.remove(directory, { recursive: true });
  }
});

test("handleFileSystemMedia serves files written by a separate drive", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const drive = createDriveResource(
      { driver: "fs", location: "./media" },
      new URL("https://example.com/"),
      pathToFileURL(directory + "/"),
    );
    await drive.use().put(
      "remote/attachment.txt",
      new TextEncoder().encode("from worker"),
    );

    const response = await handleFileSystemMedia(
      new Request("https://example.com/media/remote/attachment.txt"),
      drive.fileSystemRoot,
    );

    assert.equal(response?.status, 200);
    assert.equal(await response?.text(), "from worker");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
