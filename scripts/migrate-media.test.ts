import { assertEquals, assertRejects } from "@std/assert";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  migrateMediaDirectory,
  readChunk,
  resolveConfiguredMediaMigrationPaths,
} from "./migrate-media.ts";

const readTextFile = (path: string | URL) => readFile(path, "utf8");

async function withTemporaryDirectory(
  test: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-migrate-media-"));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true });
  }
}

test("migrateMediaDirectory preserves and copies legacy media", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "media");
    const destination = join(directory, "media");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "avatar.webp"), "avatar");
    await writeFile(join(source, "nested", "video.mp4"), "video");

    assertEquals(await migrateMediaDirectory(source, destination), {
      copied: 2,
      skipped: 0,
    });
    assertEquals(
      await readTextFile(join(destination, "avatar.webp")),
      "avatar",
    );
    assertEquals(
      await readTextFile(join(destination, "nested", "video.mp4")),
      "video",
    );
    assertEquals(await readTextFile(join(source, "avatar.webp")), "avatar");
  }));

test("migrateMediaDirectory is idempotent for identical media", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "media");
    const destination = join(directory, "media");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "avatar.webp"), "avatar");

    await migrateMediaDirectory(source, destination);
    assertEquals(await migrateMediaDirectory(source, destination), {
      copied: 0,
      skipped: 1,
    });
  }));

test("readChunk fills the buffer across short reads", async () => {
  const contents = new TextEncoder().encode("identical media");
  let position = 0;
  const file = {
    async read(buffer: Uint8Array, offset: number, length: number) {
      const bytesRead = Math.min(2, length, contents.length - position);
      buffer.set(contents.subarray(position, position + bytesRead), offset);
      position += bytesRead;
      return { buffer, bytesRead };
    },
  };
  const buffer = new Uint8Array(contents.length);

  assertEquals(await readChunk(file as never, buffer), contents.length);
  assertEquals(buffer, contents);
});

test("resolveConfiguredMediaMigrationPaths migrates custom relative locations", () => {
  assertEquals(resolveConfiguredMediaMigrationPaths("./uploads", "/app"), {
    source: "/app/web/uploads",
    destination: "/app/uploads",
  });
});

test("resolveConfiguredMediaMigrationPaths preserves absolute locations", () => {
  assertEquals(
    resolveConfiguredMediaMigrationPaths("/srv/hackerspub/uploads", "/app"),
    {
      source: "/srv/hackerspub/uploads",
      destination: "/srv/hackerspub/uploads",
    },
  );
});

test("migrate-media CLI reads a custom relative FS_LOCATION", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "uploads");
    const destination = join(directory, "uploads", "avatar.webp");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "avatar.webp"), "avatar");

    const output = spawnSync(
      process.execPath,
      [new URL("./migrate-media.ts", import.meta.url).pathname],
      {
        cwd: directory,
        env: { ...process.env, FS_LOCATION: "./uploads" },
        encoding: "utf8",
      },
    );

    assertEquals(output.status, 0, output.stderr);
    assertEquals(await readTextFile(destination), "avatar");
    assertEquals(await readTextFile(join(source, "avatar.webp")), "avatar");
  }));

test("migrateMediaDirectory leaves no partial destination after a failed copy", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "media");
    const destination = join(directory, "media");
    const destinationFile = join(destination, "avatar.webp");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "avatar.webp"), "complete");

    await assertRejects(
      () =>
        migrateMediaDirectory(source, destination, {
          copyFile: async (_source, temporaryDestination) => {
            await writeFile(temporaryDestination, "partial");
            throw new Error("copy interrupted");
          },
        }),
      Error,
      "copy interrupted",
    );
    await assertRejects(() => stat(destinationFile), Error, "ENOENT");
    assertEquals(await readdir(destination), []);

    assertEquals(await migrateMediaDirectory(source, destination), {
      copied: 1,
      skipped: 0,
    });
    assertEquals(await readTextFile(destinationFile), "complete");
  }));

test("migrateMediaDirectory refuses to overwrite different media", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "media");
    const destination = join(directory, "media");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(source, "avatar.webp"), "legacy");
    await writeFile(join(destination, "avatar.webp"), "current");

    await assertRejects(
      () => migrateMediaDirectory(source, destination),
      Error,
      "Refusing to overwrite",
    );
    assertEquals(
      await readTextFile(join(destination, "avatar.webp")),
      "current",
    );
    assertEquals(await readTextFile(join(source, "avatar.webp")), "legacy");
  }));

test("migrateMediaDirectory tolerates a missing legacy directory", () =>
  withTemporaryDirectory(async (directory) => {
    assertEquals(
      await migrateMediaDirectory(
        join(directory, "web", "media"),
        join(directory, "media"),
      ),
      { copied: 0, skipped: 0 },
    );
  }));
