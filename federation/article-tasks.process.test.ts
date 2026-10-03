import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  accountTable,
  articleContentTable,
  articleSourceTable,
  outboxEventTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { db } from "../test/database.ts";
import {
  insertAccountWithActor,
  withExclusiveTestDatabase,
} from "../test/postgres.ts";
import { waitForTaskCondition } from "../test/application-tasks.ts";

function start(
  role: "producer" | "summary-producer" | "worker",
  sourceId: string,
  pause = "",
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "temporal-polyfill/global",
      "test/article-task-process.ts",
      role,
      sourceId,
    ],
    {
      env: { ...process.env, ARTICLE_TASK_PAUSE: pause },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  const states = new Set<string>();
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  child.on("message", (message) => {
    if (typeof message === "object" && message != null && "state" in message)
      states.add(String(message.state));
  });
  return { child, exited: once(child, "exit"), states, output: () => output };
}

for (const pause of ["before", "after"]) {
  test(`translation survives SIGKILL ${pause} persistence with one summary intent`, async () => {
    await withExclusiveTestDatabase(async () => {
      const suffix = generateUuidV7().replaceAll("-", "").slice(0, 12);
      const author = await insertAccountWithActor(
        db as unknown as Parameters<typeof insertAccountWithActor>[0],
        {
          username: `killtranslation${suffix}`,
          name: "Worker Restart Translation",
          email: `killtranslation${suffix}@example.com`,
        },
      );
      const sourceId = generateUuidV7();
      const children: ReturnType<typeof start>[] = [];
      try {
        await db.insert(articleSourceTable).values({
          id: sourceId,
          accountId: author.account.id,
          publishedYear: 2026,
          slug: "worker-restart",
          tags: [],
          allowLlmTranslation: true,
        });
        await db.insert(articleContentTable).values({
          sourceId,
          language: "en",
          title: "Original title",
          content: "Original body long enough to be summarized.",
        });
        const producer = start("producer", sourceId);
        children.push(producer);
        assert.equal((await producer.exited)[0], 0, producer.output());
        const first = start("worker", sourceId, pause);
        children.push(first);
        await waitForTaskCondition(async () =>
          first.states.has(pause === "before" ? "executing" : "persisted"),
        );
        const before = await db.query.articleContentTable.findFirst({
          where: { sourceId, language: "ko" },
        });
        assert.equal(before?.beingTranslated, pause === "before");
        first.child.kill("SIGKILL");
        await first.exited;
        const second = start("worker", sourceId);
        children.push(second);
        await waitForTaskCondition(async () => {
          const row = await db.query.articleContentTable.findFirst({
            where: { sourceId, language: "ko" },
          });
          return (
            row?.beingTranslated === false && row.summary === "Short summary."
          );
        });
        await waitForTaskCondition(async () => {
          const events = await db
            .select()
            .from(outboxEventTable)
            .where(eq(outboxEventTable.eventType, "application.task"));
          return (
            events.length === 2 &&
            events.every((event) => event.status === "completed")
          );
        });
        const events = await db
          .select()
          .from(outboxEventTable)
          .where(eq(outboxEventTable.eventType, "application.task"));
        // Completed events redact payloads; their durable ordering keys remain.
        assert.equal(
          events.filter(
            (e) =>
              e.orderingKey ===
              `application.task:article-translation:${sourceId}:ko`,
          ).length,
          1,
        );
        assert.equal(
          events.filter(
            (e) =>
              e.orderingKey ===
              `application.task:article-summary:${sourceId}:ko`,
          ).length,
          1,
        );
        assert.equal(
          events.find(
            (e) =>
              e.orderingKey ===
              `application.task:article-translation:${sourceId}:ko`,
          )?.processingAttempts,
          2,
        );
        second.child.kill("SIGTERM");
        assert.equal((await second.exited)[0], 0, second.output());
      } finally {
        for (const service of children) {
          if (
            service.child.exitCode == null &&
            service.child.signalCode == null
          )
            service.child.kill("SIGKILL");
          await service.exited;
        }
        await db
          .delete(outboxEventTable)
          .where(eq(outboxEventTable.eventType, "application.task"));
        await db
          .delete(articleContentTable)
          .where(
            and(
              eq(articleContentTable.sourceId, sourceId),
              eq(articleContentTable.language, "ko"),
            ),
          );
        await db
          .delete(accountTable)
          .where(eq(accountTable.id, author.account.id));
      }
    });
  });
}

for (const pause of ["summary-before", "summary-after"]) {
  test(`summary survives SIGKILL ${pause} with the same persisted claim`, async () => {
    await withExclusiveTestDatabase(async () => {
      const suffix = generateUuidV7().replaceAll("-", "").slice(0, 12);
      const author = await insertAccountWithActor(
        db as unknown as Parameters<typeof insertAccountWithActor>[0],
        {
          username: `killsummary${suffix}`,
          name: "Worker Restart Summary",
          email: `killsummary${suffix}@example.com`,
        },
      );
      const sourceId = generateUuidV7();
      const children: ReturnType<typeof start>[] = [];
      try {
        await db.insert(articleSourceTable).values({
          id: sourceId,
          accountId: author.account.id,
          publishedYear: 2026,
          slug: "summary-restart",
          tags: [],
          allowLlmTranslation: false,
        });
        await db.insert(articleContentTable).values({
          sourceId,
          language: "en",
          title: "Summary restart",
          content:
            "An original article body long enough for a shorter summary.",
        });
        const producer = start("summary-producer", sourceId);
        children.push(producer);
        assert.equal((await producer.exited)[0], 0, producer.output());
        const queued = await db.query.articleContentTable.findFirst({
          where: { sourceId, language: "en" },
        });
        assert(queued?.summaryStarted);
        const first = start("worker", sourceId, pause);
        children.push(first);
        await waitForTaskCondition(async () =>
          first.states.has(
            pause === "summary-before" ? "summarizing" : "summary-persisted",
          ),
        );
        const before = await db.query.articleContentTable.findFirst({
          where: { sourceId, language: "en" },
        });
        if (pause === "summary-before")
          assert.equal(
            before?.summaryStarted?.getTime(),
            queued.summaryStarted.getTime(),
          );
        else assert.equal(before?.summary, "Short summary.");
        first.child.kill("SIGKILL");
        await first.exited;
        const second = start("worker", sourceId);
        children.push(second);
        await waitForTaskCondition(
          async () =>
            (
              await db.query.articleContentTable.findFirst({
                where: { sourceId, language: "en" },
              })
            )?.summary === "Short summary.",
        );
        await waitForTaskCondition(async () =>
          (
            await db
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.eventType, "application.task"))
          ).every((e) => e.status === "completed"),
        );
        const events = await db
          .select()
          .from(outboxEventTable)
          .where(eq(outboxEventTable.eventType, "application.task"));
        assert.equal(events.length, 1);
        assert.equal(events[0].processingAttempts, 2);
        assert.equal(
          second.states.has("summarizing"),
          pause === "summary-before",
        );
        assert.equal(
          (
            await db.query.articleContentTable.findFirst({
              where: { sourceId, language: "en" },
            })
          )?.summaryStarted,
          null,
        );
        second.child.kill("SIGTERM");
        assert.equal((await second.exited)[0], 0, second.output());
      } finally {
        for (const service of children) {
          if (
            service.child.exitCode == null &&
            service.child.signalCode == null
          )
            service.child.kill("SIGKILL");
          await service.exited;
        }
        await db
          .delete(outboxEventTable)
          .where(eq(outboxEventTable.eventType, "application.task"));
        await db
          .delete(accountTable)
          .where(eq(accountTable.id, author.account.id));
      }
    });
  });
}
