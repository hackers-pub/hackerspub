import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import {
  migrateMediaDirectory,
  resolveConfiguredMediaMigrationPaths,
} from "./migrate-media.ts";

async function withTemporaryDirectory(
  test: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir();
  try {
    await test(directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("migrateMediaDirectory preserves and copies legacy media", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "media");
    const destination = join(directory, "media");
    await Deno.mkdir(join(source, "nested"), { recursive: true });
    await Deno.writeTextFile(join(source, "avatar.webp"), "avatar");
    await Deno.writeTextFile(join(source, "nested", "video.mp4"), "video");

    assertEquals(await migrateMediaDirectory(source, destination), {
      copied: 2,
      skipped: 0,
    });
    assertEquals(
      await Deno.readTextFile(join(destination, "avatar.webp")),
      "avatar",
    );
    assertEquals(
      await Deno.readTextFile(join(destination, "nested", "video.mp4")),
      "video",
    );
    assertEquals(
      await Deno.readTextFile(join(source, "avatar.webp")),
      "avatar",
    );
  }));

Deno.test("migrateMediaDirectory is idempotent for identical media", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "media");
    const destination = join(directory, "media");
    await Deno.mkdir(source, { recursive: true });
    await Deno.writeTextFile(join(source, "avatar.webp"), "avatar");

    await migrateMediaDirectory(source, destination);
    assertEquals(await migrateMediaDirectory(source, destination), {
      copied: 0,
      skipped: 1,
    });
  }));

Deno.test("resolveConfiguredMediaMigrationPaths migrates custom relative locations", () => {
  assertEquals(
    resolveConfiguredMediaMigrationPaths("./uploads", "/app"),
    {
      source: "/app/web/uploads",
      destination: "/app/uploads",
    },
  );
});

Deno.test("resolveConfiguredMediaMigrationPaths preserves absolute locations", () => {
  assertEquals(
    resolveConfiguredMediaMigrationPaths("/srv/hackerspub/uploads", "/app"),
    {
      source: "/srv/hackerspub/uploads",
      destination: "/srv/hackerspub/uploads",
    },
  );
});

Deno.test("migrate-media CLI reads a custom relative FS_LOCATION", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "uploads");
    const destination = join(directory, "uploads", "avatar.webp");
    await Deno.mkdir(source, { recursive: true });
    await Deno.writeTextFile(join(source, "avatar.webp"), "avatar");

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env=FS_LOCATION",
        "--allow-read",
        "--allow-write",
        new URL("./migrate-media.ts", import.meta.url).pathname,
      ],
      cwd: directory,
      env: { FS_LOCATION: "./uploads" },
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    assertEquals(await Deno.readTextFile(destination), "avatar");
    assertEquals(
      await Deno.readTextFile(join(source, "avatar.webp")),
      "avatar",
    );
  }));

Deno.test("migrateMediaDirectory leaves no partial destination after a failed copy", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "media");
    const destination = join(directory, "media");
    const destinationFile = join(destination, "avatar.webp");
    await Deno.mkdir(source, { recursive: true });
    await Deno.writeTextFile(join(source, "avatar.webp"), "complete");

    await assertRejects(
      () =>
        migrateMediaDirectory(source, destination, {
          copyFile: async (_source, temporaryDestination) => {
            await Deno.writeTextFile(temporaryDestination, "partial");
            throw new Error("copy interrupted");
          },
        }),
      Error,
      "copy interrupted",
    );
    await assertRejects(
      () => Deno.stat(destinationFile),
      Deno.errors.NotFound,
    );
    assertEquals(await Array.fromAsync(Deno.readDir(destination)), []);

    assertEquals(await migrateMediaDirectory(source, destination), {
      copied: 1,
      skipped: 0,
    });
    assertEquals(await Deno.readTextFile(destinationFile), "complete");
  }));

Deno.test("migrateMediaDirectory refuses to overwrite different media", () =>
  withTemporaryDirectory(async (directory) => {
    const source = join(directory, "web", "media");
    const destination = join(directory, "media");
    await Deno.mkdir(source, { recursive: true });
    await Deno.mkdir(destination, { recursive: true });
    await Deno.writeTextFile(join(source, "avatar.webp"), "legacy");
    await Deno.writeTextFile(join(destination, "avatar.webp"), "current");

    await assertRejects(
      () => migrateMediaDirectory(source, destination),
      Error,
      "Refusing to overwrite",
    );
    assertEquals(
      await Deno.readTextFile(join(destination, "avatar.webp")),
      "current",
    );
    assertEquals(
      await Deno.readTextFile(join(source, "avatar.webp")),
      "legacy",
    );
  }));

Deno.test("migrateMediaDirectory tolerates a missing legacy directory", () =>
  withTemporaryDirectory(async (directory) => {
    assertEquals(
      await migrateMediaDirectory(
        join(directory, "web", "media"),
        join(directory, "media"),
      ),
      { copied: 0, skipped: 0 },
    );
  }));
