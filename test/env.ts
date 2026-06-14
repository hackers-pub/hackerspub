import process from "node:process";

let envUpdateQueue: Promise<void> = Promise.resolve();
const envLockDir = `${
  Deno.env.get("TMPDIR") ?? "/tmp"
}/hackerspub-test-env-lock`;

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
  // `deno test --parallel` can run test files in separate workers that still
  // share process environment state, so in-memory locking is not sufficient.
  const started = Date.now();
  while (true) {
    try {
      await Deno.mkdir(envLockDir);
      return async () => {
        await Deno.remove(envLockDir).catch(() => {});
      };
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      if (Date.now() - started > 120_000) {
        throw new Error(`Timed out waiting for test env lock: ${envLockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
