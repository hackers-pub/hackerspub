import { createFederationBuilder, MemoryKvStore } from "@fedify/fedify";
import { toApplicationContext } from "@hackerspub/federation/context";
import {
  TransactionalOutboxQueue,
  type TransactionalOutboxQueueOptions,
} from "@hackerspub/federation/outbox-queue";
import { registerApplicationTask } from "@hackerspub/federation/task-registry";
import type { Database } from "@hackerspub/models/db";
import {
  applicationTaskProbe,
  type ApplicationTaskHandler,
  type ApplicationTaskProbePayload,
} from "@hackerspub/models/tasks";
import { applicationTaskReceiptTable } from "@hackerspub/models/schema";
import { createFedCtx } from "./postgres.ts";

export async function createTaskFixture(
  db: Database,
  handler: ApplicationTaskHandler<ApplicationTaskProbePayload> = async (
    context,
    data,
  ) => {
    await context.db
      .insert(applicationTaskReceiptTable)
      .values({ jobId: data.jobId })
      .onConflictDoNothing();
  },
  options: TransactionalOutboxQueueOptions = {},
) {
  const task = { ...applicationTaskProbe };
  const builder =
    createFederationBuilder<ReturnType<typeof createFedCtx>["data"]>();
  registerApplicationTask(builder, task, toApplicationContext, handler);
  const queue = new TransactionalOutboxQueue(db, "application.task", {
    pollInterval: { milliseconds: 2 },
    ...options,
  });
  const federation = await builder.build({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    manuallyStartQueue: true,
    taskQueueResolution: "strict",
  });
  const data = createFedCtx(db).data;
  const context = toApplicationContext(
    federation.createContext(new URL("https://example.com"), data),
  );
  return { task, queue, federation, data, context };
}

export async function waitForTaskCondition(
  condition: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for application task state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
