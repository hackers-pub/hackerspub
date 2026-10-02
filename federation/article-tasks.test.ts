import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { startArticleContentTranslation } from "@hackerspub/models/article";
import { replayApplicationTask } from "@hackerspub/models/outbox";
import {
  articleContentTable,
  articleSourceTable,
  outboxEventTable,
} from "@hackerspub/models/schema";
import { articleTranslationTask } from "@hackerspub/models/tasks";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { createArticleTaskWorker } from "../test/article-tasks.ts";
import { waitForTaskCondition } from "../test/application-tasks.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";
import type { Transaction } from "@hackerspub/models/db";

async function fixture(tx: Transaction) {
  const author = await insertAccountWithActor(tx, {
    username: "queuedtranslation",
    name: "Queued Translation",
    email: "queuedtranslation@example.com",
  });
  const sourceId = generateUuidV7();
  await tx.insert(articleSourceTable).values({
    id: sourceId,
    accountId: author.account.id,
    publishedYear: 2026,
    slug: "queued-translation",
    tags: [],
    allowLlmTranslation: true,
  });
  const [original] = await tx
    .insert(articleContentTable)
    .values({
      sourceId,
      language: "en",
      title: "Original",
      content: "Original article body.",
    })
    .returning();
  const context = createFedCtx(tx);
  return { context, original, author, sourceId };
}

test("translation queue exhausts three attempts, retains recoverable state, and replays the same token", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    let calls = 0;
    let failing = true;
    f.context.data.services = {
      ...f.context.services,
      ai: {
        ...f.context.services.ai,
        translate: async () => {
          calls++;
          if (failing) throw new Error("Controlled translation failure");
          return "# Translated\n\nA long translated body that needs a shorter summary.";
        },
        summarize: async () => "Short.",
      },
    };
    const queued = await startArticleContentTranslation(f.context, {
      content: f.original,
      targetLanguage: "ko",
      requester: f.author.account,
    });
    let clock = Date.now();
    const worker = await createArticleTaskWorker(f.context, {
      now: () => new Date((clock += 10_000)),
      concurrency: 1,
    });
    const controller = new AbortController();
    const running = worker.federation.startQueue(worker.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(
        async () =>
          (
            await tx
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.status, "dead"))
          ).length === 1,
      );
      const [dead] = await tx
        .select()
        .from(outboxEventTable)
        .where(eq(outboxEventTable.status, "dead"));
      assert.equal(calls, 3);
      assert.equal(dead.processingAttempts, 3);
      assert.equal(dead.lastError?.message, "Controlled translation failure");
      assert(dead.payload);
      const failed = await tx.query.articleContentTable.findFirst({
        where: { sourceId: f.sourceId, language: "ko" },
      });
      assert.equal(failed?.translationJobToken, queued.translationJobToken);
      assert.equal(failed?.updated.getTime(), 0);
      failing = false;
      assert(await replayApplicationTask(tx, dead.id));
      await waitForTaskCondition(async () => {
        const row = await tx.query.articleContentTable.findFirst({
          where: { sourceId: f.sourceId, language: "ko" },
        });
        return row?.beingTranslated === false && row.summary === "Short.";
      });
      assert.equal(calls, 4);
    } finally {
      controller.abort();
      await running;
    }
  });
});

test("duplicate queued translation deliveries serialize and cannot acknowledge an unfinished LLM call", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    f.context.data.services = {
      ...f.context.services,
      ai: {
        ...f.context.services.ai,
        translate: async () => {
          calls++;
          started.resolve();
          return await release.promise;
        },
        summarize: async () => "Short.",
      },
    };
    const queued = await startArticleContentTranslation(f.context, {
      content: f.original,
      targetLanguage: "ko",
      requester: f.author.account,
    });
    await f.context.enqueueTask(
      articleTranslationTask,
      {
        sourceId: f.sourceId,
        language: "ko",
        translationJobToken: queued.translationJobToken!,
      },
      { orderingKey: `article-translation:${f.sourceId}:ko` },
    );
    const worker = await createArticleTaskWorker(f.context);
    const controller = new AbortController();
    const running = worker.federation.startQueue(worker.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await started.promise;
      // Allow the second consumer to poll while the first LLM remains blocked.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const events = await tx
        .select()
        .from(outboxEventTable)
        .where(eq(outboxEventTable.eventType, "application.task"));
      assert.equal(
        events.filter((event) => event.status === "processing").length,
        1,
      );
      assert.equal(
        events.filter((event) => event.status === "pending").length,
        1,
      );
      assert.equal(calls, 1);
      release.resolve(
        "# Translated\n\nA long translated body that needs a shorter summary.",
      );
      await waitForTaskCondition(async () => {
        const events = await tx
          .select()
          .from(outboxEventTable)
          .where(eq(outboxEventTable.eventType, "application.task"));
        return (
          events.length === 3 &&
          events.every((event) => event.status === "completed")
        );
      });
      assert.equal(calls, 1);
    } finally {
      release.resolve("# Translated\n\nBody.");
      controller.abort();
      await running;
    }
  });
});
