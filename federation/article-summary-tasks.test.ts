import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  startArticleContentSummary,
  updateArticleSource,
} from "@hackerspub/models/article";
import type { Transaction } from "@hackerspub/models/db";
import { replayApplicationTask } from "@hackerspub/models/outbox";
import {
  articleContentTable,
  articleSourceTable,
  outboxEventTable,
} from "@hackerspub/models/schema";
import { articleSummaryTask } from "@hackerspub/models/tasks";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { createArticleTaskWorker } from "../test/article-tasks.ts";
import { waitForTaskCondition } from "../test/application-tasks.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

async function fixture(tx: Transaction) {
  const author = await insertAccountWithActor(tx, {
    username: "queuedsummary",
    name: "Queued Summary",
    email: "queuedsummary@example.com",
  });
  const sourceId = generateUuidV7();
  await tx.insert(articleSourceTable).values({
    id: sourceId,
    accountId: author.account.id,
    publishedYear: 2026,
    slug: "queued-summary",
    tags: [],
    allowLlmTranslation: false,
  });
  const [content] = await tx
    .insert(articleContentTable)
    .values({
      sourceId,
      language: "en",
      title: "Summary",
      content:
        "An article body sufficiently long for a shorter summary to be useful.",
    })
    .returning();
  const context = createFedCtx(tx);
  await startArticleContentSummary(context, content);
  const row = await tx.query.articleContentTable.findFirst({
    where: { sourceId, language: "en" },
  });
  assert(row?.summaryStarted);
  const payload = {
    sourceId,
    language: "en",
    claim: row.summaryStarted.toISOString(),
  };
  return { context, sourceId, payload };
}

for (const superseded of [false, true]) {
  test(`summary queue exhausts three attempts and replay ${superseded ? "discards superseded work" : "reuses the claim"}`, async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      let calls = 0;
      let failing = true;
      f.context.data.services = {
        ...f.context.services,
        ai: {
          ...f.context.services.ai,
          summarize: async () => {
            calls++;
            if (failing) throw new Error("Controlled summary failure");
            return "Short.";
          },
        },
      };
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
        assert.equal(dead.lastError?.message, "Controlled summary failure");
        const row = await tx.query.articleContentTable.findFirst({
          where: { sourceId: f.sourceId, language: "en" },
        });
        assert.equal(row?.summaryStarted?.toISOString(), f.payload.claim);
        failing = false;
        if (superseded)
          await updateArticleSource(tx, f.sourceId, {
            content:
              "A changed article body awaiting a newly requested summary.",
          });
        assert(await replayApplicationTask(tx, dead.id));
        await waitForTaskCondition(
          async () =>
            (
              await tx.query.outboxEventTable.findFirst({
                where: { id: dead.id },
              })
            )?.status === "completed",
        );
        assert.equal(calls, superseded ? 3 : 4);
        const completed = await tx.query.articleContentTable.findFirst({
          where: { sourceId: f.sourceId, language: "en" },
        });
        assert.equal(completed?.summary, superseded ? null : "Short.");
        assert.equal(completed?.summaryStarted, null);
      } finally {
        controller.abort();
        await running;
      }
    });
  });
}

test("duplicate summary deliveries await LLM completion and perform one model call", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    f.context.data.services = {
      ...f.context.services,
      ai: {
        ...f.context.services.ai,
        summarize: async () => {
          calls++;
          started.resolve();
          return await release.promise;
        },
      },
    };
    await f.context.enqueueTask(articleSummaryTask, f.payload, {
      orderingKey: `article-summary:${f.sourceId}:en`,
    });
    const worker = await createArticleTaskWorker(f.context, { concurrency: 2 });
    const controller = new AbortController();
    const running = worker.federation.startQueue(worker.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await started.promise;
      const events = await tx
        .select()
        .from(outboxEventTable)
        .where(
          eq(
            outboxEventTable.orderingKey,
            `application.task:article-summary:${f.sourceId}:en`,
          ),
        );
      assert.equal(events.filter((e) => e.status === "completed").length, 0);
      assert.equal(calls, 1);
      release.resolve("Short.");
      await waitForTaskCondition(async () =>
        (
          await tx
            .select()
            .from(outboxEventTable)
            .where(
              eq(
                outboxEventTable.orderingKey,
                `application.task:article-summary:${f.sourceId}:en`,
              ),
            )
        ).every((e) => e.status === "completed"),
      );
      assert.equal(calls, 1);
      assert.equal(
        (
          await tx.query.articleContentTable.findFirst({
            where: { sourceId: f.sourceId, language: "en" },
          })
        )?.summary,
        "Short.",
      );
    } finally {
      release.resolve("Short.");
      controller.abort();
      await running;
    }
  });
});
