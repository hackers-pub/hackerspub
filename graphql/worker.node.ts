// Sentry is initialized by the `--import ./instrument.node.ts` preload before
// this module graph is evaluated. LogTape must then be configured before any
// application resources are created.
import "./logging.node.ts";

import { getLogger, dispose as disposeLogging } from "@logtape/logtape";
import { migrateLegacyOutboxEvents } from "@hackerspub/models/outbox";
import {
  getProcessEnvironment,
  loadStandaloneServerConfig,
} from "@hackerspub/runtime/config";
import { isMain } from "@hackerspub/runtime/main";
import {
  createRuntimeResources,
  FILE_SYSTEM_STORAGE_BASE_URL,
  type RuntimeResources,
} from "@hackerspub/runtime/resources";
import * as Sentry from "@sentry/node-sdk";
import process from "node:process";
import {
  closeWithDeadline,
  closeSequentially,
  combineRuntimeAndCloseErrors,
} from "./lifecycle.ts";
import metadata from "./deno.json" with { type: "json" };
import { services } from "./services.ts";
import { createWorkerJobs } from "./worker-jobs.ts";
import {
  resolveWorkerHealthFile,
  startWorkerHeartbeat,
  type WorkerHeartbeat,
} from "./worker-health.ts";
import { runWorkerRuntime } from "./worker-runtime.ts";
import { runNodeWorkerScheduler } from "./worker-scheduler.node.ts";

const logger = getLogger(["hackerspub", "graphql", "worker"]);
const SENTRY_CLOSE_TIMEOUT = 2_000;
const LOGGING_CLOSE_TIMEOUT = 2_000;

function closeWorkerResource(
  resource: string,
  close: () => Promise<unknown> | unknown,
): () => Promise<void> {
  return async () => {
    logger.debug("Closing GraphQL worker resource {resource}.", { resource });
    await close();
    logger.debug("Closed GraphQL worker resource {resource}.", { resource });
  };
}

function registerShutdownSignals(controller: AbortController): () => void {
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const listener = () => {
      if (controller.signal.aborted) return;
      logger.info(
        "Received {signal}; shutting down the queue worker gracefully.",
        { signal },
      );
      controller.abort();
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  return () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
  };
}

export async function main(): Promise<void> {
  const shutdownController = new AbortController();
  const removeSignalListeners = registerShutdownSignals(shutdownController);
  let resources: RuntimeResources | undefined;
  let heartbeat: WorkerHeartbeat | undefined;
  let runtimeError: unknown;

  try {
    resources = await createRuntimeResources(
      loadStandaloneServerConfig(getProcessEnvironment()),
      metadata.version,
      {
        fileSystemBaseUrl: FILE_SYSTEM_STORAGE_BASE_URL,
        federation: {
          manuallyStartQueue: true,
          // Keep this aligned with both API processes and the Deno rollback
          // worker until Bonfire interoperability is verified in production.
          firstKnock: "draft-cavage-http-signatures-12",
        },
      },
    );
    const { db, drive, email, federation, kv, models } = resources;
    const disk = drive.use();
    const jobs = createWorkerJobs({
      db,
      email,
      emailFrom: resources.config.email.from,
      origin: resources.config.origin.href,
    });

    // Pending legacy deliveries must move before any queue starts consuming.
    await migrateLegacyOutboxEvents(db);
    heartbeat = await startWorkerHeartbeat(
      resolveWorkerHealthFile(process.env.WORKER_HEALTH_FILE),
    );
    logger.info("Starting the federation message queue worker.");
    await runWorkerRuntime({
      federation,
      contextData: { db, kv, disk, models, services },
      runScheduler: (signal) => runNodeWorkerScheduler(jobs, { signal }),
      signal: shutdownController.signal,
    });
    logger.info("The federation message queue worker has stopped.");
  } catch (error) {
    runtimeError = error;
  } finally {
    removeSignalListeners();
  }

  let closeError: unknown;
  try {
    await closeSequentially(
      [
        closeWorkerResource("heartbeat", () => heartbeat?.stop()),
        closeWorkerResource("runtime", () => resources?.close()),
        closeWorkerResource("logging", () =>
          closeWithDeadline(
            () => disposeLogging(),
            LOGGING_CLOSE_TIMEOUT,
            "Timed out while closing GraphQL worker logging.",
          ),
        ),
      ],
      "Failed to close GraphQL worker resources.",
    );
  } catch (error) {
    closeError = error;
  }

  const finalError = combineRuntimeAndCloseErrors(
    runtimeError,
    closeError,
    "The GraphQL worker failed and its resources could not be closed.",
  );
  if (finalError != null) Sentry.captureException(finalError);
  try {
    await Sentry.close(SENTRY_CLOSE_TIMEOUT);
  } catch (error) {
    if (finalError != null) {
      throw new AggregateError(
        [finalError, error],
        "The GraphQL worker failed and Sentry could not be closed.",
      );
    }
    throw error;
  }
  if (finalError != null) throw finalError;
}

if (isMain(import.meta)) await main();
