// Container health probes for the three deployable roles.  The production
// image serves all of them, so `HEALTHCHECK NONE` in the Dockerfile leaves the
// choice to the deployment definition, which selects the matching
// `mise run prod:hc:*` task.
import { isMain } from "@hackerspub/runtime/main";
import process from "node:process";
import {
  checkWorkerHeartbeat,
  resolveWorkerHealthFile,
} from "../graphql/worker-health.ts";

export const HEALTH_CHECK_ROLES = [
  "graphql",
  "graphql-worker",
  "web-next",
] as const;

export type HealthCheckRole = (typeof HEALTH_CHECK_ROLES)[number];

export const DEFAULT_GRAPHQL_URL = "http://127.0.0.1:8080/graphql";
export const DEFAULT_WEB_NEXT_URL = "http://127.0.0.1:3000/search";

// Comfortably below the 5s Compose healthcheck timeout, so a hung upstream
// reports unhealthy through our own error path rather than being killed.
const PROBE_TIMEOUT_MILLISECONDS = 3_000;

export function isHealthCheckRole(value: string): value is HealthCheckRole {
  return (HEALTH_CHECK_ROLES as readonly string[]).includes(value);
}

/**
 * Probes the GraphQL API with the cheapest possible executed query.  A reply
 * that parses but carries `errors`, or whose `__typename` is not `Query`, means
 * the schema failed to build, so it counts as unhealthy rather than healthy.
 */
export async function checkGraphqlApi(
  url: string = DEFAULT_GRAPHQL_URL,
): Promise<boolean> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{__typename}" }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) {
    await discard(response);
    return false;
  }
  const result = (await response.json()) as {
    errors?: unknown;
    data?: { __typename?: unknown };
  };
  return result.errors == null && result.data?.__typename === "Query";
}

/**
 * The worker serves no HTTP surface, so it is probed through the heartbeat file
 * it refreshes on a timer.  A missing or stale file means the worker loop is no
 * longer running even if the process is still alive.
 */
export async function checkWorkerHealth(
  path: string | undefined = process.env.WORKER_HEALTH_FILE,
): Promise<boolean> {
  return await checkWorkerHeartbeat(resolveWorkerHealthFile(path));
}

/**
 * `/search` is used rather than `/` because it renders without a session and
 * without hitting a redirect, so it exercises SSR and the GraphQL upstream.
 */
export async function checkWebNext(
  url: string = DEFAULT_WEB_NEXT_URL,
): Promise<boolean> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
  });
  await discard(response);
  return response.ok;
}

// An unread response body holds its socket open, which would keep this
// short-lived process alive past the probe.
async function discard(response: Response): Promise<void> {
  await response.body?.cancel();
}

export async function runHealthCheck(role: HealthCheckRole): Promise<boolean> {
  switch (role) {
    case "graphql":
      return await checkGraphqlApi();
    case "graphql-worker":
      return await checkWorkerHealth();
    case "web-next":
      return await checkWebNext();
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const role = args[0];
  if (role == null || args.length !== 1 || !isHealthCheckRole(role)) {
    console.error(
      `Usage: node scripts/healthcheck.ts <${HEALTH_CHECK_ROLES.join("|")}>`,
    );
    process.exitCode = 1;
    return;
  }
  let healthy: boolean;
  try {
    healthy = await runHealthCheck(role);
  } catch (error) {
    console.error(`Health check for ${role} failed:`, error);
    process.exitCode = 1;
    return;
  }
  if (!healthy) {
    console.error(`Health check for ${role} reported an unhealthy service.`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta)) await main();
