import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

let envUpdateQueue: Promise<void> = Promise.resolve();
const envLockDir = join(tmpdir(), "hackerspub-test-env-lock");

export async function withProcessEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  let release!: () => void;
  const previousUpdate = envUpdateQueue;
  const currentUpdate = new Promise<void>((resolve) => {
    release = resolve;
  });
  envUpdateQueue = previousUpdate.then(
    () => currentUpdate,
    () => currentUpdate,
  );

  await previousUpdate;
  let releaseFileLock: () => Promise<void>;
  try {
    releaseFileLock = await acquireEnvLock();
  } catch (error) {
    release();
    throw error;
  }
  const previousValues = new Map<string, string | undefined>();
  try {
    for (const [name, value] of Object.entries(values)) {
      previousValues.set(name, process.env[name]);
      if (value == null) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await run();
  } finally {
    try {
      for (const [name, value] of previousValues) {
        if (value == null) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    } finally {
      await releaseFileLock();
      release();
    }
  }
}

export async function withTagsPubRelayEnabled(
  run: () => Promise<void>,
): Promise<void> {
  await withProcessEnv({ TAGS_PUB_RELAY: "true" }, run);
}

async function acquireEnvLock(): Promise<() => Promise<void>> {
  // `node --test` runs each file in its own process, so the queue above
  // serializes callers within a file and nothing across them; one process
  // never observes another's `process.env`.  What needs serializing is the
  // window itself: several files flip a flag whose behavior reaches the
  // shared test database, and they run concurrently.
  const started = Date.now();
  while (true) {
    try {
      await mkdir(envLockDir);
      return async () => {
        await rm(envLockDir, { recursive: true }).catch(() => {});
      };
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }
      if (Date.now() - started > 120_000) {
        throw new Error(`Timed out waiting for test env lock: ${envLockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
