import { fileURLToPath } from "node:url";
import {
  checkWorkerHeartbeat,
  WORKER_HEARTBEAT_MAX_AGE_MILLISECONDS,
} from "../graphql/worker-health.ts";
import { waitUntil } from "./smoke-readiness.ts";

const heartbeatPath = `/tmp/hackerspub-standalone-smoke-${Deno.pid}.health`;
const graphqlDirectory = fileURLToPath(
  new URL("../graphql/", import.meta.url),
);
const webNextDirectory = fileURLToPath(
  new URL("../web-next/", import.meta.url),
);
const standaloneKvUrl = Deno.env.get("STANDALONE_SMOKE_KV_URL") ??
  "redis://127.0.0.1:6379/0";
const processes: Deno.ChildProcess[] = [];

function start(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Record<string, string> = {},
) {
  const process = new Deno.Command(command, {
    args: [...args],
    cwd,
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
  start(
    Deno.execPath(),
    ["run", "-A", "--unstable-otel", "--unstable-cron", "main.ts"],
    graphqlDirectory,
    { KV_URL: standaloneKvUrl },
  );
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

  start(
    Deno.execPath(),
    ["run", "-A", "--unstable-otel", "--unstable-cron", "worker.ts"],
    graphqlDirectory,
    {
      KV_URL: standaloneKvUrl,
      WORKER_HEALTH_FILE: heartbeatPath,
    },
  );
  await waitUntil("the GraphQL worker heartbeat", () =>
    checkWorkerHeartbeat(
      heartbeatPath,
      WORKER_HEARTBEAT_MAX_AGE_MILLISECONDS,
    ));

  start(
    "node",
    [
      "--enable-source-maps",
      "--import",
      "./instrument.server.mjs",
      ".output/server/index.mjs",
    ],
    webNextDirectory,
    { API_URL: "http://127.0.0.1:8080/graphql" },
  );
  await waitUntil("web-next", async (signal) => {
    const response = await fetch("http://127.0.0.1:3000/search", { signal });
    return response.ok;
  });
} finally {
  for (const process of processes.reverse()) await stop(process);
  await removeHeartbeat();
}
