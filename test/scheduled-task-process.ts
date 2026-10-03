// Isolated process fixture: actual cron dispatch/registry/queue, no external I/O.
import { applicationTaskReceiptTable } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { dispatchScheduledWorkerJob } from "../graphql/worker-dispatch.ts";
import { runWorkerRuntime } from "../graphql/worker-runtime.ts";
import { db, postgres } from "./database.ts";
import { createScheduledTaskWorker } from "./scheduled-tasks.ts";

const role = process.argv[2];
const jobId = process.argv[3];
if (!validateUuid(jobId)) throw new TypeError("A receipt UUID is required.");
const scheduled = "2026-10-03T03:45:00.000Z";
const fixture = await createScheduledTaskWorker(
  db,
  async (data, execution) => {
    if (data.scheduled !== scheduled)
      throw new Error("Scheduled interval changed.");
    const pause = async (state: string) => {
      process.send?.({ state });
      await new Promise<void>((resolve) => {
        if (execution.signal.aborted) resolve();
        else
          execution.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
    };
    if (process.env.SCHEDULED_PROCESS_PAUSE === "before") {
      await pause("executing");
      execution.signal.throwIfAborted();
    }
    await db
      .insert(applicationTaskReceiptTable)
      .values({ jobId })
      .onConflictDoNothing();
    if (process.env.SCHEDULED_PROCESS_PAUSE === "after")
      await pause("persisted");
  },
  {
    leaseDuration: { milliseconds: 300 },
    heartbeatInterval: { milliseconds: 50 },
    concurrency: 1,
  },
);

try {
  if (role === "producer") {
    await dispatchScheduledWorkerJob(fixture.context, {
      jobName: "prune-article-view-deduplications",
      scheduled,
    });
    process.send?.({ state: "dispatched" });
  } else if (role === "worker") {
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    await runWorkerRuntime({
      federation: fixture.federation,
      contextData: fixture.data,
      runScheduler: async (signal) => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
      signal: controller.signal,
    });
  } else throw new TypeError("Expected producer or worker.");
} finally {
  await postgres.end();
}
