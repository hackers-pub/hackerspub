import { MemoryKvStore } from "@fedify/fedify";
import { builder } from "@hackerspub/federation";
import { toApplicationContext } from "@hackerspub/federation/context";
import {
  TransactionalOutboxQueue,
  type TransactionalOutboxQueueOptions,
} from "@hackerspub/federation/outbox-queue";
import type { ContextData } from "@hackerspub/models/context";
import type { Database } from "@hackerspub/models/db";
import { createFedCtx } from "./postgres.ts";

/** Actual shared registry and persistent queue, with worker-owned operations. */
export async function createScheduledTaskWorker(
  db: Database,
  execute: ContextData["executeScheduledWorkerJob"],
  options: TransactionalOutboxQueueOptions = {},
) {
  const queue = new TransactionalOutboxQueue(db, "application.task", {
    pollInterval: { milliseconds: 2 },
    ...options,
  });
  const federation = await builder.build({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });
  const data = { ...createFedCtx(db).data, executeScheduledWorkerJob: execute };
  const context = toApplicationContext(
    federation.createContext(new URL("https://example.com"), data),
  );
  return { queue, federation, data, context };
}
