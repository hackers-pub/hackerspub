// Real durable task queue with controlled AI and no scheduler or remote delivery.
import { createFederationBuilder, MemoryKvStore } from "@fedify/fedify";
import { TransactionalOutboxQueue } from "@hackerspub/federation/outbox-queue";
import { registerApplicationTask } from "@hackerspub/federation/task-registry";
import {
  executeArticleTranslation,
  executeArticleTranslationSummary,
  startArticleContentTranslation,
} from "@hackerspub/models/article";
import type { ContextData } from "@hackerspub/models/context";
import {
  articleTranslationTask,
  articleTranslationSummaryTask,
} from "@hackerspub/models/tasks";
import { validateUuid } from "@hackerspub/models/uuid";
import { db, postgres } from "./database.ts";
import { createFedCtx } from "./postgres.ts";

const role = process.argv[2];
const sourceId = process.argv[3];
if (!validateUuid(sourceId))
  throw new TypeError("Expected an article source UUID.");
const context = createFedCtx(db);
context.data.services = {
  ...context.services,
  ai: {
    ...context.services.ai,
    translate: async (options) => {
      process.send?.({ state: "executing" });
      if (process.env.ARTICLE_TASK_PAUSE === "before") {
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        options.signal!.throwIfAborted();
      }
      return "# Translated title\n\nTranslated body that is long enough for a short summary.";
    },
    summarize: async () => "Short summary.",
  },
};
const builder = createFederationBuilder<ContextData>();
registerApplicationTask(
  builder,
  { ...articleTranslationTask },
  () => context,
  async (ctx, data, execution) => {
    await executeArticleTranslation(ctx, data, execution);
    process.send?.({ state: "persisted" });
    if (process.env.ARTICLE_TASK_PAUSE === "after") {
      await new Promise<void>((resolve) =>
        execution.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    }
  },
);
registerApplicationTask(
  builder,
  { ...articleTranslationSummaryTask },
  () => context,
  executeArticleTranslationSummary,
);
const queue = new TransactionalOutboxQueue(db, "application.task", {
  pollInterval: { milliseconds: 2 },
  leaseDuration: { milliseconds: 300 },
  heartbeatInterval: { milliseconds: 50 },
  concurrency: 1,
});
const federation = await builder.build({
  kv: new MemoryKvStore(),
  queue: { task: queue },
  taskQueueResolution: "strict",
  manuallyStartQueue: true,
});
try {
  if (role === "producer") {
    const original = await db.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    const source = await db.query.articleSourceTable.findFirst({
      where: { id: sourceId },
      with: { account: true },
    });
    if (original == null || source == null)
      throw new Error("Missing fixture article.");
    await startArticleContentTranslation(context, {
      content: original,
      targetLanguage: "ko",
      requester: source.account,
    });
  } else if (role === "worker") {
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    process.once("SIGINT", () => controller.abort());
    process.send?.({ state: "ready" });
    await federation.startQueue(context.data, {
      queue: "task",
      signal: controller.signal,
    });
  } else throw new TypeError("Expected producer or worker.");
} finally {
  await postgres.end();
}
