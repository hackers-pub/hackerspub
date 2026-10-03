import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  createArticle,
  createArticleSource,
  executeArticleSummary,
  executeArticleTranslationSummary,
  startArticleContentSummary,
  publishArticleTranslation,
  updateArticle,
} from "./article.ts";
import { saveArticleTranslationDraft } from "./article-translation.ts";
import type { Database, Transaction } from "./db.ts";
import { articleContentTable, outboxEventTable } from "./schema.ts";
import { articleSummaryTask, articleTranslationSummaryTask } from "./tasks.ts";
import { withTransaction } from "./tx.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

const execution = (attempt = 0, signal = new AbortController().signal) => ({
  attempt,
  signal,
});

async function fixture(tx: Transaction) {
  const author = await insertAccountWithActor(tx, {
    username: "summarytaskauthor",
    name: "Summary Task Author",
    email: "summarytaskauthor@example.com",
  });
  const context = createFedCtx(tx);
  const inputs: {
    text: string;
    sourceLanguage: string;
    targetLanguage: string;
  }[] = [];
  context.data.services = {
    ...context.services,
    ai: {
      ...context.services.ai,
      summarize: async (options) => {
        inputs.push(options);
        return "Short summary.";
      },
    },
  };
  const article = await createArticle(context, {
    accountId: author.account.id,
    publishedYear: 2026,
    slug: "summary-tasks",
    tags: [],
    allowLlmTranslation: false,
    title: "Summary tasks",
    language: "en",
    content:
      "An original article with enough text for a shorter generated summary to be useful.",
  });
  assert(article);
  const sourceId = article.articleSource.id;
  const row = () =>
    tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
  const payload = async () => {
    const current = await row();
    assert(current?.summaryStarted);
    return {
      sourceId,
      language: "en",
      claim: current.summaryStarted.toISOString(),
    };
  };
  const tasks = () =>
    tx
      .select()
      .from(outboxEventTable)
      .where(
        eq(
          outboxEventTable.orderingKey,
          `application.task:article-summary:${sourceId}:en`,
        ),
      );
  return { context, article, author, sourceId, row, payload, tasks, inputs };
}

test("summary aliases retain the exact old task schema and registration identity", () => {
  assert.equal(articleSummaryTask, articleTranslationSummaryTask);
  assert.equal(executeArticleSummary, executeArticleTranslationSummary);
  const data = {
    sourceId: generateUuidV7(),
    language: "en",
    claim: new Date().toISOString(),
  };
  assert.deepEqual(articleSummaryTask.schema["~standard"].validate(data), {
    value: data,
  });
  assert(
    articleSummaryTask.schema["~standard"].validate({
      ...data,
      claim: "invalid",
    }).issues,
  );
});

test("creation queues one durable claim without LLM work and duplicate producers coalesce", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    assert.equal(f.inputs.length, 0);
    assert.equal((await f.tasks()).length, 1);
    const data = await f.payload();
    await startArticleContentSummary(
      f.context,
      f.article.articleSource.contents[0],
    );
    assert.equal((await f.tasks()).length, 1);
    assert.deepEqual(await f.payload(), data);
    await executeArticleSummary(f.context, data, execution());
    await executeArticleSummary(f.context, data, execution());
    await startArticleContentSummary(f.context, {
      sourceId: f.sourceId,
      language: "en",
    });
    assert.equal(f.inputs.length, 1);
    assert.equal((await f.tasks()).length, 1);
    assert.equal((await f.row())?.summary, "Short summary.");
    assert.equal(
      (await tx.query.postTable.findFirst({ where: { id: f.article.id } }))
        ?.summary,
      "Short summary.",
    );
    assert.equal(
      (
        await tx.query.postContentVariantTable.findFirst({
          where: { postId: f.article.id, language: "en" },
        })
      )?.summary,
      "Short summary.",
    );
  });
});

test("source creation and enclosing transaction rollback discard summary intents", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const context = f.context;
    const sourceId = generateUuidV7();
    await assert.rejects(
      withTransaction(context, async (nested) => {
        const source = await createArticleSource(nested, {
          id: sourceId,
          accountId: f.author.account.id,
          publishedYear: 2026,
          slug: "rolled-back-summary",
          tags: [],
          title: "Rolled back",
          content: "A sufficiently long original article body.",
          language: "en",
        });
        assert(source);
        throw new Error("outer rollback");
      }),
      /outer rollback/,
    );
    assert.equal(
      await tx.query.articleSourceTable.findFirst({ where: { id: sourceId } }),
      undefined,
    );
    assert.equal((await f.tasks()).length, 1);

    const failing = createFedCtx(tx);
    failing.enqueueTask = async () => {
      throw new Error("summary enqueue failed");
    };
    await assert.rejects(
      createArticleSource(failing, {
        id: sourceId,
        accountId: f.author.account.id,
        publishedYear: 2026,
        slug: "failed-summary",
        tags: [],
        title: "Failed",
        content: "A sufficiently long original article body.",
        language: "en",
      }),
      /summary enqueue failed/,
    );
    assert.equal(
      await tx.query.articleSourceTable.findFirst({ where: { id: sourceId } }),
      undefined,
    );
    assert.equal((await f.tasks()).length, 1);
  });
});

test("LLM and persistence errors retain the same claim for retry with atomic post summaries", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const data = await f.payload();
    const services = f.context.services;
    f.context.data.services = {
      ...services,
      ai: {
        ...services.ai,
        summarize: async () => {
          throw new Error("LLM unavailable");
        },
      },
    };
    await assert.rejects(
      executeArticleSummary(f.context, data, execution()),
      /LLM unavailable/,
    );
    assert.deepEqual(await f.payload(), data);
    f.context.data.services = services;
    const failedDb = new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "transaction")
          return (callback: (db: Transaction) => Promise<void>) =>
            target.transaction(async (nested) => {
              await callback(nested);
              throw new Error("DB persistence failed");
            });
        return Reflect.get(target, property, receiver);
      },
    }) as Database;
    await assert.rejects(
      executeArticleSummary({ ...f.context, db: failedDb }, data, execution(1)),
      /DB persistence failed/,
    );
    assert.equal((await f.row())?.summary, null);
    assert.equal(
      (await tx.query.postTable.findFirst({ where: { id: f.article.id } }))
        ?.summary,
      null,
    );
    assert.deepEqual(await f.payload(), data);
    await executeArticleSummary(f.context, data, execution(2));
    assert.equal((await f.row())?.summary, "Short summary.");
  });
});

for (const result of [
  "Old summary.",
  "",
  "This outdated summary is much longer than the new source body could ever be.",
]) {
  test(`edit during summary execution discards stale result ${JSON.stringify(result)}`, async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const old = await f.payload();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<string>();
      const services = f.context.services;
      f.context.data.services = {
        ...services,
        ai: {
          ...services.ai,
          summarize: async () => {
            started.resolve();
            return await release.promise;
          },
        },
      };
      let settled = false;
      const running = executeArticleSummary(f.context, old, execution()).then(
        () => {
          settled = true;
        },
      );
      await started.promise;
      assert.equal(settled, false);
      await updateArticle(f.context, f.sourceId, {
        content:
          "A newly edited body with sufficient text for a useful summary to be generated.",
      });
      const current = await f.payload();
      release.resolve(result);
      await running;
      assert.equal(settled, true);
      assert.equal((await f.row())?.summary, null);
      assert.equal((await f.row())?.summaryUnnecessary, false);
      assert.deepEqual(await f.payload(), current);
      f.context.data.services = services;
      await executeArticleSummary(f.context, current, execution());
      assert.equal((await f.row())?.summary, "Short summary.");
      await executeArticleSummary(f.context, old, execution());
      assert.equal(f.inputs.length, 1);
    });
  });
}

test("delayed summaries use latest text, title edits retain claims, and deleted jobs skip LLM", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const old = await f.payload();
    await updateArticle(f.context, f.sourceId, { title: "New title" });
    assert.deepEqual(await f.payload(), old);
    await updateArticle(f.context, f.sourceId, {
      content:
        "A changed article body long enough to benefit from summarization.",
    });
    const current = await f.payload();
    await executeArticleSummary(f.context, old, execution());
    assert.equal(f.inputs.length, 0);
    await executeArticleSummary(f.context, current, execution());
    assert.equal(
      f.inputs[0].text,
      "A changed article body long enough to benefit from summarization.",
    );
    assert.equal(f.inputs[0].sourceLanguage, "en");
    assert.equal(f.inputs[0].targetLanguage, "en");
    await tx
      .delete(articleContentTable)
      .where(
        and(
          eq(articleContentTable.sourceId, f.sourceId),
          eq(articleContentTable.language, "en"),
        ),
      );
    await executeArticleSummary(f.context, current, execution());
    assert.equal(f.inputs.length, 1);
  });
});

test("cancellation leaves an immediately retryable claim and does not persist late output", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const data = await f.payload();
    const controller = new AbortController();
    const services = f.context.services;
    f.context.data.services = {
      ...services,
      ai: {
        ...services.ai,
        summarize: async (options) => {
          assert.equal(options.signal, controller.signal);
          controller.abort();
          return "Late summary.";
        },
      },
    };
    await assert.rejects(
      executeArticleSummary(f.context, data, execution(0, controller.signal)),
      { name: "AbortError" },
    );
    assert.equal((await f.row())?.summary, null);
    assert.deepEqual(await f.payload(), data);
    f.context.data.services = services;
    await executeArticleSummary(f.context, data, execution(1));
    assert.equal((await f.row())?.summary, "Short summary.");
  });
});

for (const state of [
  { beingTranslated: true, originalLanguage: "en", provenance: "llm" as const },
  { summaryUnnecessary: true },
  { summary: "Already completed." },
]) {
  test(`worker excludes ineligible current rows ${JSON.stringify(state)}`, async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const data = await f.payload();
      await tx
        .update(articleContentTable)
        .set(state)
        .where(eq(articleContentTable.sourceId, f.sourceId));
      await executeArticleSummary(f.context, data, execution());
      assert.equal(f.inputs.length, 0);
    });
  });
}

test("summary handler waits for persistence and source edits roll back failed dispatch", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const data = await f.payload();
    const persisting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const waitingDb = new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "transaction")
          return (callback: (db: Transaction) => Promise<void>) =>
            target.transaction(async (nested) => {
              await callback(nested);
              persisting.resolve();
              await release.promise;
            });
        return Reflect.get(target, property, receiver);
      },
    }) as Database;
    let settled = false;
    const running = executeArticleSummary(
      { ...f.context, db: waitingDb },
      data,
      execution(),
    ).then(() => {
      settled = true;
    });
    await persisting.promise;
    assert.equal(settled, false);
    release.resolve();
    await running;
    assert.equal(settled, true);
    const before = await f.row();
    const failing = createFedCtx(tx);
    failing.enqueueTask = async () => {
      throw new Error("edit summary enqueue failed");
    };
    await assert.rejects(
      updateArticle(failing, f.sourceId, {
        content:
          "An edited body whose enqueue must roll back with its content change.",
      }),
      /edit summary enqueue failed/,
    );
    assert.deepEqual(await f.row(), before);
  });
});

test("explicit recovery reclaims a stale legacy summary and reads latest body", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const staleSnapshot = f.article.articleSource.contents[0];
    await tx
      .update(articleContentTable)
      .set({
        summaryStarted: new Date(0),
        content:
          "The most recent article body, not the producer's stale snapshot, needs a summary.",
      })
      .where(eq(articleContentTable.sourceId, f.sourceId));
    await startArticleContentSummary(f.context, staleSnapshot);
    await executeArticleSummary(f.context, await f.payload(), execution());
    assert.equal(
      f.inputs[0].text,
      "The most recent article body, not the producer's stale snapshot, needs a summary.",
    );
  });
});

test("human translation publication queues summary atomically and preserves original post summary", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    await executeArticleSummary(f.context, await f.payload(), execution());
    const draft = await saveArticleTranslationDraft(tx, f.author.account, {
      sourceId: f.sourceId,
      language: "ko",
      title: "한국어 제목",
      content:
        "요약을 생성할 수 있을 만큼 충분히 긴 한국어 번역 본문입니다. 번역문 자체가 요약 입력이어야 합니다.",
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    assert.equal(
      (
        await publishArticleTranslation(f.context, f.author.account, {
          translationDraftId: draft.draft.id,
          revision: draft.draft.revision,
        })
      ).status,
      "ok",
    );
    const content = await tx.query.articleContentTable.findFirst({
      where: { sourceId: f.sourceId, language: "ko" },
    });
    assert(content?.summaryStarted);
    assert.equal(content.summary, null);
    const events = await tx
      .select()
      .from(outboxEventTable)
      .where(
        eq(
          outboxEventTable.orderingKey,
          `application.task:article-summary:${f.sourceId}:ko`,
        ),
      );
    assert.equal(events.length, 1);
    await executeArticleSummary(
      f.context,
      {
        sourceId: f.sourceId,
        language: "ko",
        claim: content.summaryStarted.toISOString(),
      },
      execution(),
    );
    assert.equal(f.inputs[1].sourceLanguage, "ko");
    assert.equal(f.inputs[1].targetLanguage, "ko");
    assert.equal(
      (await tx.query.postTable.findFirst({ where: { id: f.article.id } }))
        ?.summary,
      "Short summary.",
    );
  });
});
