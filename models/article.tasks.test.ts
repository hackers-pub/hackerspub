import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  createArticle,
  executeArticleTranslation,
  executeArticleTranslationSummary,
  restartArticleContentTranslations,
  startArticleContentTranslation,
  updateArticleSource,
} from "./article.ts";
import {
  articleContentTable,
  articleSourceTable,
  outboxEventTable,
  postContentVariantTable,
  postTable,
} from "./schema.ts";
import {
  articleTranslationSummaryTask,
  articleTranslationTask,
  type ArticleTranslationTaskPayload,
} from "./tasks.ts";
import { withTransaction } from "./tx.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";
import { waitFor } from "../test/wait.ts";
import type { ApplicationContext } from "./context.ts";
import type { Transaction } from "./db.ts";

const execution = () => ({ signal: new AbortController().signal, attempt: 0 });

async function fixture(tx: Transaction) {
  const author = await insertAccountWithActor(tx, {
    username: "tasktranslationauthor",
    name: "Task Translation Author",
    email: "tasktranslationauthor@example.com",
  });
  const context = createFedCtx(tx);
  let calls = 0;
  context.data.services = {
    ...context.services,
    ai: {
      ...context.services.ai,
      translate: async () => {
        calls++;
        return "# Translated title\n\nA translated body long enough to have a shorter summary.";
      },
      summarize: async () => "Short summary.",
    },
  };
  const article = await createArticle(context, {
    accountId: author.account.id,
    publishedYear: 2026,
    slug: "task-translation",
    tags: ["typescript"],
    allowLlmTranslation: true,
    title: "Original title",
    content:
      "The original body is long enough to have a shorter generated summary.",
    language: "en",
  });
  assert(article);
  const sourceId = article.articleSource.id;
  await waitFor(async () => {
    const row = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    return row?.summary != null;
  });
  const original = await tx.query.articleContentTable.findFirst({
    where: { sourceId, language: "en" },
  });
  assert(original);
  const enqueue = () =>
    startArticleContentTranslation(context, {
      content: original,
      targetLanguage: "ko",
      requester: author.account,
    });
  const payload = (
    token: NonNullable<typeof original.translationJobToken>,
  ): ArticleTranslationTaskPayload => ({
    sourceId,
    language: "ko",
    translationJobToken: token,
  });
  const row = () =>
    tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
  const tasks = async (name: string) =>
    (await tx.select().from(outboxEventTable)).filter(
      (event) =>
        (event.payload as { taskName?: string } | null)?.taskName === name,
    );
  return {
    context,
    author,
    article,
    original,
    sourceId,
    enqueue,
    payload,
    row,
    tasks,
    calls: () => calls,
  };
}

test("translation task schemas preserve stored language keys and reject invalid identifiers/claims", () => {
  const data = {
    sourceId: generateUuidV7(),
    language: "en-us",
    translationJobToken: generateUuidV7(),
  };
  const schema = articleTranslationTask.schema["~standard"];
  assert.deepEqual(schema.validate(data), { value: data });
  assert.deepEqual(schema.validate(data), { value: data });
  assert(schema.validate({ ...data, sourceId: "invalid" }).issues);
  assert(schema.validate({ ...data, language: "garbage" }).issues);
  const summarySchema = articleTranslationSummaryTask.schema["~standard"];
  const summary = {
    sourceId: data.sourceId,
    language: "ko",
    claim: new Date().toISOString(),
  };
  assert.deepEqual(summarySchema.validate(summary), { value: summary });
  assert(summarySchema.validate({ ...summary, claim: "bad" }).issues);
  assert(summarySchema.validate({ ...summary, claim: "2026-01-01" }).issues);
});

test("translation producer returns promptly, atomically persists intent, and rolls back enqueue failures", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    await assert.rejects(
      withTransaction(f.context, async (context) => {
        await startArticleContentTranslation(context, {
          content: f.original,
          targetLanguage: "ko",
          requester: f.author.account,
        });
        throw new Error("rollback producer");
      }),
      /rollback producer/,
    );
    assert.equal(await f.row(), undefined);
    assert.equal((await f.tasks(articleTranslationTask.name)).length, 0);
    const enqueue = f.context.enqueueTask;
    f.context.enqueueTask = async () => {
      throw new Error("enqueue unavailable");
    };
    await assert.rejects(f.enqueue(), /enqueue unavailable/);
    assert.equal(await f.row(), undefined);
    f.context.enqueueTask = enqueue;
    const queued = await f.enqueue();
    assert.equal(f.calls(), 0);
    assert.equal(queued.beingTranslated, true);
    assert.equal((await f.tasks(articleTranslationTask.name)).length, 1);
    await f.enqueue();
    assert.equal((await f.tasks(articleTranslationTask.name)).length, 1);
  });
});

test("translation worker awaits completion, retains provenance/variants, and durably dispatches one awaited summary", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const queued = await f.enqueue();
    const data = f.payload(queued.translationJobToken!);
    await executeArticleTranslation(f.context, data, execution());
    const row = await f.row();
    assert(row?.summaryStarted);
    assert.equal(row.beingTranslated, false);
    assert.equal(row.translationJobToken, null);
    assert.equal(row.title, "Translated title");
    assert.equal(row.provenance, "llm");
    assert.equal(row.translationRequesterId, f.author.account.id);
    assert.equal(row.sourceRevisionId, queued.sourceRevisionId);
    assert.equal((await f.tasks(articleTranslationSummaryTask.name)).length, 1);
    const variant = await tx.query.postContentVariantTable.findFirst({
      where: { postId: f.article.id, language: "ko" },
    });
    assert.equal(variant?.name, "Translated title");
    await executeArticleTranslation(f.context, data, execution());
    assert.equal(f.calls(), 1);
    assert.equal((await f.tasks(articleTranslationSummaryTask.name)).length, 1);
    const summaryPayload = {
      sourceId: f.sourceId,
      language: "ko",
      claim: row.summaryStarted.toISOString(),
    };
    await executeArticleTranslationSummary(
      f.context,
      summaryPayload,
      execution(),
    );
    assert.equal((await f.row())?.summary, "Short summary.");
    await executeArticleTranslationSummary(
      f.context,
      summaryPayload,
      execution(),
    );
    const summarizedVariant = await tx.query.postContentVariantTable.findFirst({
      where: { postId: f.article.id, language: "ko" },
    });
    assert.equal(summarizedVariant?.summary, "Short summary.");
  });
});

test("LLM failure and changed claim retry use the original payload; reader reclaim safely supersedes it", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const queued = await f.enqueue();
    const data = f.payload(queued.translationJobToken!);
    const ai = f.context.services.ai;
    f.context.data.services = {
      ...f.context.services,
      ai: {
        ...ai,
        translate: async () => {
          throw new Error("LLM down");
        },
      },
    };
    await assert.rejects(
      executeArticleTranslation(f.context, data, execution()),
      /LLM down/,
    );
    assert.equal((await f.row())?.updated.getTime(), 0);
    f.context.data.services = { ...f.context.services, ai };
    await executeArticleTranslation(f.context, data, {
      ...execution(),
      attempt: 1,
    });
    assert.equal((await f.row())?.beingTranslated, false);

    const reset = await restartArticleContentTranslations(
      f.context,
      f.article.articleSource,
    );
    const oldData = f.payload(reset[0].translationJobToken!);
    f.context.data.services = {
      ...f.context.services,
      ai: {
        ...ai,
        translate: async () => {
          throw new Error("retry gap");
        },
      },
    };
    await assert.rejects(
      executeArticleTranslation(f.context, oldData, execution()),
      /retry gap/,
    );
    const reclaimed = await f.enqueue();
    assert.notEqual(reclaimed.translationJobToken, oldData.translationJobToken);
    f.context.data.services = { ...f.context.services, ai };
    const before = f.calls();
    await executeArticleTranslation(f.context, oldData, {
      ...execution(),
      attempt: 1,
    });
    assert.equal(f.calls(), before);
    await executeArticleTranslation(
      f.context,
      f.payload(reclaimed.translationJobToken!),
      execution(),
    );
    assert.equal((await f.row())?.beingTranslated, false);
  });
});

test("a failed summary enqueue rolls back translation publication and retries the same token", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const queued = await f.enqueue();
    const data = f.payload(queued.translationJobToken!);
    const appContext: ApplicationContext = f.context;
    const enqueue = appContext.enqueueTask;
    appContext.enqueueTask = async function (task, payload, options) {
      if (task === articleTranslationSummaryTask)
        throw new Error("summary enqueue failed");
      await enqueue.call(this, task, payload, options);
    };
    await assert.rejects(
      executeArticleTranslation(f.context, data, execution()),
      /summary enqueue failed/,
    );
    assert.equal((await f.row())?.beingTranslated, true);
    assert.equal((await f.row())?.title, "Original title");
    assert.equal((await f.tasks(articleTranslationSummaryTask.name)).length, 0);
    assert.equal(
      await tx.query.postContentVariantTable.findFirst({
        where: { postId: f.article.id, language: "ko" },
      }),
      undefined,
    );
    f.context.enqueueTask = enqueue;
    await executeArticleTranslation(f.context, data, {
      ...execution(),
      attempt: 1,
    });
    assert.equal((await f.row())?.beingTranslated, false);
  });
});

for (const timing of ["before", "during"] as const) {
  test(`disabling LLM ${timing} execution deletes only its placeholder without publication`, async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const queued = await f.enqueue();
      let published = 0;
      f.context.sendActivity = async () => {
        published++;
      };
      const disable = () =>
        tx
          .update(articleSourceTable)
          .set({ allowLlmTranslation: false })
          .where(eq(articleSourceTable.id, f.sourceId));
      if (timing === "before") await disable();
      else {
        const ai = f.context.services.ai;
        f.context.data.services = {
          ...f.context.services,
          ai: {
            ...ai,
            translate: async (options) => {
              await disable();
              return await ai.translate(options);
            },
          },
        };
      }
      await executeArticleTranslation(
        f.context,
        f.payload(queued.translationJobToken!),
        execution(),
      );
      assert.equal(await f.row(), undefined);
      assert.equal(f.calls(), timing === "before" ? 0 : 1);
      assert.equal(published, 0);
      assert.equal(
        (await f.tasks(articleTranslationSummaryTask.name)).length,
        0,
      );
    });
  });
}

test("edits during execution and stale/deleted tasks never publish old output", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const queued = await f.enqueue();
    const ai = f.context.services.ai;
    f.context.data.services = {
      ...f.context.services,
      ai: {
        ...ai,
        translate: async (options) => {
          await updateArticleSource(tx, f.sourceId, {
            content: "Edited original body that must be translated instead.",
          });
          await restartArticleContentTranslations(
            f.context,
            f.article.articleSource,
          );
          return await ai.translate(options);
        },
      },
    };
    await executeArticleTranslation(
      f.context,
      f.payload(queued.translationJobToken!),
      execution(),
    );
    const current = await f.row();
    assert.equal(current?.beingTranslated, true);
    assert.equal(
      current?.content,
      "Edited original body that must be translated instead.",
    );
    assert.notEqual(current?.translationJobToken, queued.translationJobToken);
    assert.equal((await f.tasks(articleTranslationSummaryTask.name)).length, 0);
    f.context.data.services = { ...f.context.services, ai };
    await executeArticleTranslation(
      f.context,
      f.payload(queued.translationJobToken!),
      execution(),
    );
    assert.equal(f.calls(), 1);
    await tx
      .delete(articleContentTable)
      .where(
        and(
          eq(articleContentTable.sourceId, f.sourceId),
          eq(articleContentTable.language, "ko"),
        ),
      );
    await executeArticleTranslation(
      f.context,
      f.payload(current!.translationJobToken!),
      execution(),
    );
    assert.equal(f.calls(), 1);
  });
});

for (const timing of ["before", "during"] as const) {
  test(`a title-only edit ${timing} execution refreshes and durably replaces an obsolete job`, async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx);
      const queued = await f.enqueue();
      const ai = f.context.services.ai;
      let published = 0;
      f.context.sendActivity = async () => {
        published++;
      };
      const edit = () =>
        updateArticleSource(tx, f.sourceId, { title: "Edited title" });
      if (timing === "before") await edit();
      else {
        f.context.data.services = {
          ...f.context.services,
          ai: {
            ...ai,
            translate: async (options) => {
              await edit();
              return await ai.translate(options);
            },
          },
        };
      }
      const oldPayload = f.payload(queued.translationJobToken!);
      await executeArticleTranslation(f.context, oldPayload, execution());
      const refreshed = await f.row();
      assert(refreshed);
      assert.equal(refreshed.title, "Edited title");
      assert.equal(refreshed.content, f.original.content);
      assert.equal(refreshed.beingTranslated, true);
      assert.notEqual(
        refreshed.translationJobToken,
        queued.translationJobToken,
      );
      const original = await tx.query.articleContentTable.findFirst({
        where: { sourceId: f.sourceId, language: "en" },
      });
      assert.equal(refreshed.sourceRevisionId, original?.sourceRevisionId);
      assert.equal((await f.tasks(articleTranslationTask.name)).length, 2);
      assert.equal(
        (await f.tasks(articleTranslationSummaryTask.name)).length,
        0,
      );
      assert.equal(published, 0);
      f.context.data.services = { ...f.context.services, ai };
      await executeArticleTranslation(f.context, oldPayload, execution());
      assert.equal(f.calls(), timing === "before" ? 0 : 1);
      await executeArticleTranslation(
        f.context,
        f.payload(refreshed.translationJobToken!),
        execution(),
      );
      assert.equal((await f.row())?.beingTranslated, false);
      assert.equal(
        (await f.tasks(articleTranslationSummaryTask.name)).length,
        1,
      );
    });
  });
}

test("obsolete-job replacement rolls back if its durable enqueue fails", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const queued = await f.enqueue();
    await updateArticleSource(tx, f.sourceId, { title: "Edited title" });
    const enqueue = f.context.enqueueTask;
    f.context.enqueueTask = async () => {
      throw new Error("replacement enqueue failed");
    };
    const payload = f.payload(queued.translationJobToken!);
    await assert.rejects(
      executeArticleTranslation(f.context, payload, execution()),
      /replacement enqueue failed/,
    );
    assert.equal(
      (await f.row())?.translationJobToken,
      queued.translationJobToken,
    );
    assert.equal((await f.row())?.title, "Original title");
    assert.equal((await f.tasks(articleTranslationTask.name)).length, 1);
    assert.equal(f.calls(), 0);
    f.context.enqueueTask = enqueue;
    await executeArticleTranslation(f.context, payload, execution());
    assert.equal((await f.tasks(articleTranslationTask.name)).length, 2);
    assert.equal((await f.row())?.title, "Edited title");
  });
});

test("censorship keeps reader materialization and summary dispatch but suppresses federation", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const queued = await f.enqueue();
    await tx
      .update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, f.article.id));
    let sent = 0;
    f.context.sendActivity = async () => {
      sent++;
    };
    await executeArticleTranslation(
      f.context,
      f.payload(queued.translationJobToken!),
      execution(),
    );
    assert.equal(sent, 0);
    assert.equal((await f.row())?.beingTranslated, false);
    assert.equal((await f.tasks(articleTranslationSummaryTask.name)).length, 1);
    assert(
      await tx
        .select()
        .from(postContentVariantTable)
        .where(eq(postContentVariantTable.postId, f.article.id)),
    );
  });
});

test("translation cancellation retains a recoverable claim and fences a late LLM result", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const queued = await f.enqueue();
    const controller = new AbortController();
    const ai = f.context.services.ai;
    f.context.data.services = {
      ...f.context.services,
      ai: {
        ...ai,
        translate: async (options) => {
          assert.equal(options.signal, controller.signal);
          controller.abort();
          return await ai.translate(options);
        },
      },
    };
    await assert.rejects(
      executeArticleTranslation(
        f.context,
        f.payload(queued.translationJobToken!),
        {
          signal: controller.signal,
          attempt: 0,
        },
      ),
    );
    const current = await f.row();
    assert.equal(current?.beingTranslated, true);
    assert.equal(current?.translationJobToken, queued.translationJobToken);
    assert.notEqual(current?.updated.getTime(), 0);
    f.context.data.services = { ...f.context.services, ai };
    await executeArticleTranslation(
      f.context,
      f.payload(queued.translationJobToken!),
      { ...execution(), attempt: 1 },
    );
    assert.equal((await f.row())?.beingTranslated, false);
  });
});

test("summary bridge retries its persisted claim and ignores superseded/deleted/completed rows", async () => {
  await withRollback(async (tx) => {
    const f = await fixture(tx);
    const queued = await f.enqueue();
    await executeArticleTranslation(
      f.context,
      f.payload(queued.translationJobToken!),
      execution(),
    );
    const row = await f.row();
    assert(row?.summaryStarted);
    const data = {
      sourceId: f.sourceId,
      language: "ko",
      claim: row.summaryStarted.toISOString(),
    };
    const ai = f.context.services.ai;
    f.context.data.services = {
      ...f.context.services,
      ai: {
        ...ai,
        summarize: async () => {
          throw new Error("summary failed");
        },
      },
    };
    await assert.rejects(
      executeArticleTranslationSummary(f.context, data, execution()),
      /summary failed/,
    );
    assert.equal((await f.row())?.summaryStarted?.toISOString(), data.claim);
    f.context.data.services = { ...f.context.services, ai };
    await executeArticleTranslationSummary(f.context, data, {
      ...execution(),
      attempt: 1,
    });
    assert.equal((await f.row())?.summary, "Short summary.");
    await executeArticleTranslationSummary(f.context, data, execution());
    await restartArticleContentTranslations(f.context, f.article.articleSource);
    await executeArticleTranslationSummary(f.context, data, execution());
    assert.equal((await f.row())?.summary, null);
    await tx
      .delete(articleContentTable)
      .where(
        and(
          eq(articleContentTable.sourceId, f.sourceId),
          eq(articleContentTable.language, "ko"),
        ),
      );
    await executeArticleTranslationSummary(f.context, data, execution());
  });
});
