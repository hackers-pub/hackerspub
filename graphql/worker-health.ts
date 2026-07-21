export interface WorkerHeartbeat {
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

interface WorkerHeartbeatOptions {
  intervalMilliseconds?: number;
  now?: () => number;
}

export const DEFAULT_WORKER_HEALTH_FILE =
  "/tmp/hackerspub-graphql-worker.health";
export const WORKER_HEARTBEAT_INTERVAL_MILLISECONDS = 10_000;
export const WORKER_HEARTBEAT_MAX_AGE_MILLISECONDS = 30_000;

export function resolveWorkerHealthFile(path: string | undefined): string {
  return path || DEFAULT_WORKER_HEALTH_FILE;
}

export async function startWorkerHeartbeat(
  path: string,
  options: WorkerHeartbeatOptions = {},
): Promise<WorkerHeartbeat> {
  const now = options.now ?? Date.now;
  const refresh = async () => {
    await Deno.writeTextFile(path, String(now()));
  };
  await refresh();
  const interval = setInterval(
    () => void refresh().catch(() => undefined),
    options.intervalMilliseconds ?? WORKER_HEARTBEAT_INTERVAL_MILLISECONDS,
  );
  let stopped = false;
  return {
    refresh,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    },
  };
}

export async function checkWorkerHeartbeat(
  path: string,
  maximumAgeMilliseconds = WORKER_HEARTBEAT_MAX_AGE_MILLISECONDS,
  now: () => number = Date.now,
): Promise<boolean> {
  try {
    const timestamp = Number(await Deno.readTextFile(path));
    return Number.isFinite(timestamp) &&
      now() - timestamp <= maximumAgeMilliseconds;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
