import {
  checkWorkerHeartbeat,
  WORKER_HEARTBEAT_MAX_AGE_MILLISECONDS,
} from "../graphql/worker-health.ts";
import { waitUntil } from "./smoke-readiness.ts";

const heartbeatPath = `/tmp/hackerspub-standalone-smoke-${Deno.pid}.health`;
const processes: Deno.ChildProcess[] = [];

function start(task: string, environment: Record<string, string> = {}) {
  const process = new Deno.Command("mise", {
    args: ["run", task],
    env: environment,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  processes.push(process);
  return process;
}

async function stop(process: Deno.ChildProcess) {
  try {
    process.kill("SIGTERM");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  let timeoutId: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), 10_000);
  });
  let result: Deno.CommandStatus | null;
  try {
    result = await Promise.race([process.status, timeout]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
  if (result == null) {
    try {
      process.kill("SIGKILL");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await process.status;
  }
}

async function removeHeartbeat() {
  try {
    await Deno.remove(heartbeatPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

try {
  start("prod:graphql");
  await waitUntil("the standalone GraphQL API", async (signal) => {
    const response = await fetch("http://127.0.0.1:8080/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{__typename}" }),
      signal,
    });
    const body = await response.json();
    return response.ok && body.data?.__typename === "Query";
  });

  start("prod:graphql-worker", { WORKER_HEALTH_FILE: heartbeatPath });
  await waitUntil("the GraphQL worker heartbeat", () =>
    checkWorkerHeartbeat(
      heartbeatPath,
      WORKER_HEARTBEAT_MAX_AGE_MILLISECONDS,
    ));

  start("prod:web-next");
  await waitUntil("web-next", async (signal) => {
    const response = await fetch("http://127.0.0.1:3000/search", { signal });
    return response.ok;
  });
} finally {
  for (const process of processes.reverse()) await stop(process);
  await removeHeartbeat();
}
