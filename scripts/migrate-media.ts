import { randomUUID } from "node:crypto";
import {
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { isMain } from "@hackerspub/runtime/main";

export interface MediaMigrationResult {
  readonly copied: number;
  readonly skipped: number;
}

export interface MediaMigrationOptions {
  readonly copyFile?: (source: string, destination: string) => Promise<void>;
}

export interface MediaMigrationPaths {
  readonly source: string;
  readonly destination: string;
}

export function resolveConfiguredMediaMigrationPaths(
  location: string,
  applicationRoot: string,
): MediaMigrationPaths {
  return {
    source: resolve(applicationRoot, "web", location),
    destination: resolve(applicationRoot, location),
  };
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
}

export async function readChunk(
  file: FileHandle,
  buffer: Uint8Array,
): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset;
}

async function filesEqual(
  source: string,
  destination: string,
): Promise<boolean> {
  const [sourceInfo, destinationInfo] = await Promise.all([
    stat(source),
    stat(destination),
  ]);
  if (sourceInfo.size !== destinationInfo.size) return false;

  const [sourceFile, destinationFile] = await Promise.all([
    open(source, "r"),
    open(destination, "r"),
  ]);
  const sourceBuffer = new Uint8Array(64 * 1024);
  const destinationBuffer = new Uint8Array(sourceBuffer.length);
  try {
    while (true) {
      const [sourceLength, destinationLength] = await Promise.all([
        readChunk(sourceFile, sourceBuffer),
        readChunk(destinationFile, destinationBuffer),
      ]);
      if (sourceLength !== destinationLength) return false;
      if (sourceLength === 0) return true;
      for (let index = 0; index < sourceLength; index++) {
        if (sourceBuffer[index] !== destinationBuffer[index]) return false;
      }
    }
  } finally {
    await sourceFile.close();
    await destinationFile.close();
  }
}

async function copyFileWithoutOverwrite(
  source: string,
  destination: string,
  result: { copied: number; skipped: number },
  options: MediaMigrationOptions,
): Promise<void> {
  const destinationInfo = await lstatOrUndefined(destination);
  if (destinationInfo != null) {
    if (destinationInfo.isFile() && (await filesEqual(source, destination))) {
      result.skipped++;
      return;
    }
    throw new Error(
      `Refusing to overwrite existing media with different content: ${destination}`,
    );
  }

  const temporaryDestination = join(
    dirname(destination),
    `.hackerspub-media-migration-${basename(
      destination,
    )}-${process.pid}-${randomUUID()}.tmp`,
  );
  let installed = false;
  try {
    await (options.copyFile ?? copyFile)(source, temporaryDestination);
    const sourceInfo = await stat(source);
    await utimes(temporaryDestination, sourceInfo.atime, sourceInfo.mtime);

    const concurrentDestinationInfo = await lstatOrUndefined(destination);
    if (concurrentDestinationInfo != null) {
      if (
        concurrentDestinationInfo.isFile() &&
        (await filesEqual(source, destination))
      ) {
        result.skipped++;
        return;
      }
      throw new Error(
        `Refusing to overwrite existing media with different content: ${destination}`,
      );
    }

    await rename(temporaryDestination, destination);
    installed = true;
    result.copied++;
  } finally {
    if (!installed) {
      await removeIfPresent(temporaryDestination);
    }
  }
}

async function copyDirectory(
  source: string,
  destination: string,
  result: { copied: number; skipped: number },
  options: MediaMigrationOptions,
): Promise<void> {
  const destinationInfo = await lstatOrUndefined(destination);
  if (destinationInfo == null) {
    await mkdir(destination, { recursive: true });
  } else if (!destinationInfo.isDirectory()) {
    throw new Error(
      `Refusing to overwrite non-directory media path: ${destination}`,
    );
  }

  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath, result, options);
    } else if (entry.isFile()) {
      await copyFileWithoutOverwrite(
        sourcePath,
        destinationPath,
        result,
        options,
      );
    } else {
      throw new Error(`Unsupported legacy media entry: ${sourcePath}`);
    }
  }
}

export async function migrateMediaDirectory(
  source: string,
  destination: string,
  options: MediaMigrationOptions = {},
): Promise<MediaMigrationResult> {
  if (resolve(source) === resolve(destination)) {
    return { copied: 0, skipped: 0 };
  }
  const sourceInfo = await lstatOrUndefined(source);
  if (sourceInfo == null) return { copied: 0, skipped: 0 };
  if (!sourceInfo.isDirectory()) {
    throw new Error(`Legacy media path is not a directory: ${source}`);
  }

  const result = { copied: 0, skipped: 0 };
  await copyDirectory(source, destination, result, options);
  return result;
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && args.length !== 2) {
    throw new Error("Usage: migrate-media.ts [source destination]");
  }
  const { source, destination } =
    args.length === 2
      ? { source: resolve(args[0]), destination: resolve(args[1]) }
      : resolveConfiguredMediaMigrationPaths(
          process.env.FS_LOCATION?.trim() || "./media",
          process.cwd(),
        );
  const result = await migrateMediaDirectory(source, destination);
  console.log(
    `Legacy media migration complete: ${result.copied} copied, ${result.skipped} already present.`,
  );
}
