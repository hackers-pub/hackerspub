import { basename, dirname, join, resolve } from "node:path";

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

async function lstatOrUndefined(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function readChunk(
  file: Deno.FsFile,
  buffer: Uint8Array,
): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const count = await file.read(buffer.subarray(offset));
    if (count == null || count === 0) break;
    offset += count;
  }
  return offset;
}

async function filesEqual(
  source: string,
  destination: string,
): Promise<boolean> {
  const [sourceInfo, destinationInfo] = await Promise.all([
    Deno.stat(source),
    Deno.stat(destination),
  ]);
  if (sourceInfo.size !== destinationInfo.size) return false;

  const [sourceFile, destinationFile] = await Promise.all([
    Deno.open(source, { read: true }),
    Deno.open(destination, { read: true }),
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
    sourceFile.close();
    destinationFile.close();
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
    if (destinationInfo.isFile && await filesEqual(source, destination)) {
      result.skipped++;
      return;
    }
    throw new Error(
      `Refusing to overwrite existing media with different content: ${destination}`,
    );
  }

  const temporaryDestination = await Deno.makeTempFile({
    dir: dirname(destination),
    prefix: `.hackerspub-media-migration-${basename(destination)}-`,
    suffix: ".tmp",
  });
  let installed = false;
  try {
    await (options.copyFile ?? Deno.copyFile)(source, temporaryDestination);
    const sourceInfo = await Deno.stat(source);
    if (sourceInfo.atime != null && sourceInfo.mtime != null) {
      await Deno.utime(
        temporaryDestination,
        sourceInfo.atime,
        sourceInfo.mtime,
      );
    }

    const concurrentDestinationInfo = await lstatOrUndefined(destination);
    if (concurrentDestinationInfo != null) {
      if (
        concurrentDestinationInfo.isFile &&
        await filesEqual(source, destination)
      ) {
        result.skipped++;
        return;
      }
      throw new Error(
        `Refusing to overwrite existing media with different content: ${destination}`,
      );
    }

    await Deno.rename(temporaryDestination, destination);
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
    await Deno.mkdir(destination, { recursive: true });
  } else if (!destinationInfo.isDirectory) {
    throw new Error(
      `Refusing to overwrite non-directory media path: ${destination}`,
    );
  }

  for await (const entry of Deno.readDir(source)) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory) {
      await copyDirectory(sourcePath, destinationPath, result, options);
    } else if (entry.isFile) {
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
  if (!sourceInfo.isDirectory) {
    throw new Error(`Legacy media path is not a directory: ${source}`);
  }

  const result = { copied: 0, skipped: 0 };
  await copyDirectory(source, destination, result, options);
  return result;
}

if (import.meta.main) {
  if (Deno.args.length !== 0 && Deno.args.length !== 2) {
    throw new Error("Usage: migrate-media.ts [source destination]");
  }
  const { source, destination } = Deno.args.length === 2
    ? { source: resolve(Deno.args[0]), destination: resolve(Deno.args[1]) }
    : resolveConfiguredMediaMigrationPaths(
      Deno.env.get("FS_LOCATION")?.trim() || "./media",
      Deno.cwd(),
    );
  const result = await migrateMediaDirectory(source, destination);
  console.log(
    `Legacy media migration complete: ${result.copied} copied, ${result.skipped} already present.`,
  );
}
