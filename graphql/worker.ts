// Must be the first import — see instrument.ts for the rationale.
import "./instrument.ts";
import "./logging.ts";

import { migrateLegacyOutboxEvents } from "@hackerspub/models/outbox";
import {
  getDenoEnvironment,
  loadStandaloneServerConfig,
} from "@hackerspub/runtime/config";
import {
  createRuntimeResources,
  FILE_SYSTEM_STORAGE_BASE_URL,
} from "@hackerspub/runtime/resources";
import { getLogger } from "@logtape/logtape";
import metadata from "./deno.json" with { type: "json" };
import {
  closeSequentially,
  combineRuntimeAndCloseErrors,
} from "./lifecycle.ts";
import { services } from "./services.ts";
import {
  createWorkerJobs,
  waitForWorkerJobsToDrain,
  WORKER_JOB_DRAIN_WARNING_MILLISECONDS,
  WorkerJobRunner,
} from "./worker-jobs.ts";
import {
  resolveWorkerHealthFile,
  startWorkerHeartbeat,
  type WorkerHeartbeat,
} from "./worker-health.ts";

const resources = await createRuntimeResources(
  loadStandaloneServerConfig(getDenoEnvironment()),
  metadata.version,
  {
    fileSystemBaseUrl: FILE_SYSTEM_STORAGE_BASE_URL,
    federation: {
      manuallyStartQueue: true,
      // TODO: Revert to Fedify's default RFC 9421-first behavior once
      // https://github.com/bonfire-networks/activity_pub/issues/8 is fixed
      // and released. Keep this aligned with the API process.
      firstKnock: "draft-cavage-http-signatures-12",
    },
  },
);
const { db, drive, email, federation, kv, models } = resources;

const logger = getLogger(["hackerspub", "graphql", "worker"]);

// One controller coordinates graceful shutdown of the scheduled jobs and the
// queue consumer. Registering signal listeners overrides Deno's default
// termination, so both long-lived services must observe this signal.
const controller = new AbortController();
const signalListeners: Array<{
  readonly signal: "SIGINT" | "SIGTERM";
  readonly listener: () => void;
}> = [];
for (const signalName of ["SIGINT", "SIGTERM"] as const) {
  const listener = () => {
    if (controller.signal.aborted) return;
    logger.info(
      "Received {signal}; shutting down the queue worker gracefully.",
      { signal: signalName },
    );
    controller.abort();
  };
  Deno.addSignalListener(signalName, listener);
  signalListeners.push({ signal: signalName, listener });
}

const jobs = createWorkerJobs({
  db,
  email,
  emailFrom: resources.config.email.from,
  origin: resources.config.origin.href,
});
const jobRunner = new WorkerJobRunner();

// Drain the federation inbox and transactional fanout/delivery queues. The API
// processes build the same federation with `manuallyStartQueue: true` and only
// enqueue, so this dedicated process is the sole consumer on the GraphQL stack
// side. It must not be placed behind a load balancer.
const disk = drive.use();
logger.info("Starting the federation message queue worker.");
let heartbeat: WorkerHeartbeat | undefined;
const cronCompletions: Promise<void>[] = [];
let runtimeError: unknown;
try {
  await migrateLegacyOutboxEvents(db);
  heartbeat = await startWorkerHeartbeat(
    resolveWorkerHealthFile(Deno.env.get("WORKER_HEALTH_FILE")),
  );
  for (const job of jobs) {
    cronCompletions.push(
      Deno.cron(job.name, job.schedule, { signal: controller.signal }, () =>
        jobRunner.run(job),
      ),
    );
  }
  await federation.startQueue(
    { db, kv, disk, models, services },
    { signal: controller.signal },
  );
  logger.info("The federation message queue worker has stopped.");
} catch (error) {
  runtimeError = error;
} finally {
  controller.abort();
  for (const { signal, listener } of signalListeners) {
    Deno.removeSignalListener(signal, listener);
  }
}

let closeError: unknown;
try {
  await closeSequentially(
    [
      async () => {
        await waitForWorkerJobsToDrain(
          async () => {
            await Promise.all(cronCompletions);
            await jobRunner.drain();
          },
          WORKER_JOB_DRAIN_WARNING_MILLISECONDS,
          () => {
            logger.warning(
              "Deno scheduled worker jobs exceeded the drain warning " +
                "threshold; keeping resources open until they settle.",
              {
                warningAfterMilliseconds: WORKER_JOB_DRAIN_WARNING_MILLISECONDS,
              },
            );
          },
        );
      },
      () => heartbeat?.stop(),
      () => resources.close(),
    ],
    "Failed to close Deno worker resources.",
  );
} catch (error) {
  closeError = error;
}
const finalError = combineRuntimeAndCloseErrors(
  runtimeError,
  closeError,
  "The Deno worker failed and its resources could not be closed.",
);
if (finalError != null) throw finalError;
