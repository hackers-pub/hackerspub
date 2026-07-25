import { type ChildProcess, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  checkWorkerHeartbeat,
  WORKER_HEARTBEAT_MAX_AGE_MILLISECONDS,
} from "../graphql/worker-health.ts";
import { type ReadinessCheck, waitUntil } from "./smoke-readiness.ts";

const heartbeatPath = `/tmp/hackerspub-standalone-smoke-${process.pid}.health`;
const graphqlDirectory = fileURLToPath(new URL("../graphql/", import.meta.url));
const webNextDirectory = fileURLToPath(
  new URL("../web-next/", import.meta.url),
);
const standaloneKvUrl =
  process.env.STANDALONE_SMOKE_KV_URL ?? "redis://127.0.0.1:6379/0";

interface ServiceExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

interface Service {
  readonly name: string;
  readonly child: ChildProcess;
  /** Settles when the child is gone, however it got there.  Never rejects. */
  readonly exit: Promise<ServiceExit>;
  /** Whether {@link exit} has already settled. */
  readonly gone: boolean;
}

const services: Service[] = [];

function start(
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Record<string, string> = {},
): Service {
  const child = spawn(command, [...args], {
    cwd,
    // `spawn` replaces the environment outright, so the ambient configuration
    // (DATABASE_URL, SECRET_KEY, PATH, ...) has to be carried over explicitly.
    env: { ...process.env, ...environment },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let gone = false;
  let started = false;
  // `spawn` reports failures like ENOENT or EMFILE asynchronously, so these
  // listeners have to be attached before anything is awaited: an unhandled
  // `error` event throws out of the event loop, escaping the cleanup below and
  // orphaning services that already started.
  const exit = new Promise<ServiceExit>((resolve) => {
    const settle = (result: ServiceExit) => {
      gone = true;
      resolve(result);
    };
    child.once("spawn", () => {
      started = true;
    });
    child.on("error", (error) => {
      // An `error` before the `spawn` event means the child never ran.
      // Afterwards it means something like a signal that could not be
      // delivered, and the child is still alive, so only `close` may report it
      // as gone: treating a failed kill as a clean exit would leave the service
      // running after this script returns.
      if (started) {
        console.error(`${name} raised a runtime error:`, error);
      } else {
        settle({ code: null, signal: null, error });
      }
    });
    child.once("close", (code, signal) => settle({ code, signal }));
  });
  const service: Service = {
    name,
    child,
    exit,
    get gone() {
      return gone;
    },
  };
  services.push(service);
  return service;
}

function describeExit(exit: ServiceExit): string {
  if (exit.error != null) return `: ${exit.error.message}`;
  if (exit.signal != null) return ` after receiving ${exit.signal}`;
  return ` with exit code ${exit.code}`;
}

/**
 * Waits for a service to become ready, but gives up as soon as it dies.  A
 * service that fails on startup would otherwise be reported only as a readiness
 * timeout a minute later, hiding the actual error it printed.
 */
async function waitForReadiness(
  service: Service,
  description: string,
  check: ReadinessCheck,
): Promise<void> {
  const died = service.exit.then((exit) => {
    throw new Error(
      `Waiting for ${description} failed: ` +
        `${service.name} exited${describeExit(exit)}.`,
    );
  });
  // Readiness usually wins, and the eventual shutdown must not surface as an
  // unhandled rejection.
  died.catch(() => {});
  await Promise.race([waitUntil(description, check), died]);
}

const GRACEFUL_SHUTDOWN_TIMEOUT = 10_000;
const FORCED_SHUTDOWN_TIMEOUT = 5_000;

async function hasExited(
  service: Service,
  timeoutMilliseconds: number,
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMilliseconds);
  });
  try {
    return (await Promise.race([service.exit, timeout])) !== "timeout";
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

/**
 * Terminates a service, escalating to `SIGKILL`.  Returns a description of the
 * problem instead of throwing, and never waits without a bound, so that one
 * unkillable service can neither hang the script nor stop the remaining ones
 * from being cleaned up.
 */
async function stop(service: Service): Promise<string | undefined> {
  if (!service.gone) service.child.kill("SIGTERM");
  if (await hasExited(service, GRACEFUL_SHUTDOWN_TIMEOUT)) return undefined;
  service.child.kill("SIGKILL");
  if (await hasExited(service, FORCED_SHUTDOWN_TIMEOUT)) return undefined;
  // A live child handle keeps this process's event loop alive, so giving up on
  // it has to mean releasing it too; otherwise the script reports the problem
  // and then hangs instead of exiting.  The stdio is inherited, so there are no
  // pipe handles left to release.
  service.child.unref();
  return (
    `${service.name} survived both SIGTERM and SIGKILL; ` +
    "it may still be running."
  );
}

try {
  const api = start(
    "the GraphQL API",
    "node",
    [
      "--enable-source-maps",
      "--import",
      "temporal-polyfill/global",
      "--import",
      "./instrument.ts",
      "main.ts",
    ],
    graphqlDirectory,
    { KV_URL: standaloneKvUrl },
  );
  await waitForReadiness(api, "the standalone GraphQL API", async (signal) => {
    const response = await fetch("http://127.0.0.1:8080/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{__typename}" }),
      signal,
    });
    const body = await response.json();
    return response.ok && body.data?.__typename === "Query";
  });
  await waitForReadiness(
    api,
    "the standalone federation routes",
    async (signal) => {
      const [nodeInfo, assetlinks, appleAssociation] = await Promise.all([
        fetch("http://127.0.0.1:8080/.well-known/nodeinfo", { signal }),
        fetch("http://127.0.0.1:8080/.well-known/assetlinks.json", {
          signal,
        }),
        fetch("http://127.0.0.1:8080/.well-known/apple-app-site-association", {
          signal,
        }),
      ]);
      return (
        nodeInfo.ok &&
        assetlinks.ok &&
        appleAssociation.ok &&
        nodeInfo.headers
          .get("content-type")
          ?.startsWith("application/jrd+json") === true &&
        assetlinks.headers
          .get("content-type")
          ?.startsWith("application/json") === true &&
        appleAssociation.headers
          .get("content-type")
          ?.startsWith("application/json") === true
      );
    },
  );

  const worker = start(
    "the federation worker",
    "node",
    [
      "--enable-source-maps",
      "--import",
      "temporal-polyfill/global",
      "--import",
      "./instrument.ts",
      "worker.ts",
    ],
    graphqlDirectory,
    {
      KV_URL: standaloneKvUrl,
      WORKER_HEALTH_FILE: heartbeatPath,
    },
  );
  await waitForReadiness(worker, "the GraphQL worker heartbeat", () =>
    checkWorkerHeartbeat(heartbeatPath, WORKER_HEARTBEAT_MAX_AGE_MILLISECONDS),
  );

  const webNext = start(
    "web-next",
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
  await waitForReadiness(webNext, "web-next", async (signal) => {
    const response = await fetch("http://127.0.0.1:3000/search", { signal });
    return response.ok;
  });
} finally {
  const problems: string[] = [];
  for (const service of services.reverse()) {
    const problem = await stop(service);
    if (problem != null) problems.push(problem);
  }
  await rm(heartbeatPath, { force: true });
  if (problems.length > 0) {
    // Reported rather than thrown: a smoke failure is more interesting than
    // the cleanup trouble that follows it, so it must not be overwritten.
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  }
}
