// Isolated producer/worker fixture: no scheduler, delivery, email, or LLM I/O.
import process from "node:process";
import { applicationTaskReceiptTable } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { db, postgres } from "./database.ts";
import { createTaskFixture } from "./application-tasks.ts";

const role = process.argv[2];
const jobId = process.argv[3];
if (!validateUuid(jobId)) throw new TypeError("A UUID job id is required.");
const fixture = await createTaskFixture(
  db,
  async (context, data, execution) => {
    if (process.env.TASK_PROCESS_PAUSE === "before") {
      process.send?.({ state: "executing" });
      await new Promise<void>((resolve) =>
        execution.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      execution.signal.throwIfAborted();
    }
    await context.db
      .insert(applicationTaskReceiptTable)
      .values({ jobId: data.jobId })
      .onConflictDoNothing();
    process.send?.({ state: "persisted" });
    if (process.env.TASK_PROCESS_PAUSE === "after") {
      await new Promise<void>((resolve) =>
        execution.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    }
  },
  {
    leaseDuration: { milliseconds: 300 },
    heartbeatInterval: { milliseconds: 50 },
    concurrency: 1,
  },
);

try {
  if (role === "producer") {
    await fixture.context.enqueueTask(fixture.task, { jobId });
    process.stdout.write(`${JSON.stringify({ jobId, state: "enqueued" })}\n`);
  } else if (role === "worker") {
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    process.send?.({ state: "ready" });
    await fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
  } else {
    throw new TypeError("Expected producer or worker role.");
  }
} finally {
  await postgres.end();
}
