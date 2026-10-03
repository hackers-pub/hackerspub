import { MemoryKvStore } from "@fedify/fedify";
import { builder } from "@hackerspub/federation";
import { toApplicationContext } from "@hackerspub/federation/context";
import { TransactionalOutboxQueue } from "@hackerspub/federation/outbox-queue";
import type {
  ApplicationContext,
  ContextData,
} from "@hackerspub/models/context";
import type {
  ApplicationTask,
  ApplicationTaskEnqueueOptions,
} from "@hackerspub/models/tasks";

/** Give model fixtures the actual producer without implicitly starting workers. */
export async function enqueueTestArticleTask<T>(
  context: ApplicationContext & { data: ContextData },
  task: ApplicationTask<T>,
  data: T,
  options?: ApplicationTaskEnqueueOptions,
): Promise<void> {
  const queue = new TransactionalOutboxQueue(context.db, "application.task");
  const federation = await builder.build({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });
  await toApplicationContext(
    federation.createContext(new URL(context.origin), {
      ...context.data,
      db: context.db,
    }),
  ).enqueueTask(task, data, options);
}

/** Real registry/queue execution while model fixtures control AI and delivery. */
export async function createArticleTaskWorker(
  context: ApplicationContext & { data: ContextData },
  options: import("@hackerspub/federation/outbox-queue").TransactionalOutboxQueueOptions = {},
) {
  const { createFederationBuilder } = await import("@fedify/fedify");
  const { registerApplicationTask } =
    await import("@hackerspub/federation/task-registry");
  const { articleTranslationTask, articleTranslationSummaryTask } =
    await import("@hackerspub/models/tasks");
  const { executeArticleTranslation, executeArticleTranslationSummary } =
    await import("@hackerspub/models/article");
  const registry = createFederationBuilder<ContextData>();
  registerApplicationTask(
    registry,
    { ...articleTranslationTask },
    () => context,
    executeArticleTranslation,
  );
  registerApplicationTask(
    registry,
    { ...articleTranslationSummaryTask },
    () => context,
    executeArticleTranslationSummary,
  );
  const queue = new TransactionalOutboxQueue(context.db, "application.task", {
    pollInterval: { milliseconds: 2 },
    ...options,
  });
  const federation = await registry.build({
    kv: new MemoryKvStore(),
    queue: { task: queue },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
  });
  return { queue, federation, data: context.data };
}
