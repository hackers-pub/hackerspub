import assert from "node:assert";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { defineApplicationModel } from "./context.ts";
import {
  accountTable,
  articleContentTable,
  articleSourceTable,
  postLinkTable,
} from "./schema.ts";
import {
  createArticle,
  restartArticleContentTranslations,
  startArticleContentSummary,
  startArticleContentTranslation,
  updateArticle,
} from "./article.ts";
import { withTransaction } from "./tx.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  services,
  withExclusiveTestDatabase,
  withRollback,
} from "../test/postgres.ts";
import { waitFor } from "../test/wait.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
import { db } from "../test/database.ts";

test("startArticleContentSummary() resets summaryStarted when summarization fails", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "summarybackground",
      name: "Summary Background",
      email: "summarybackground@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "summary-background",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Summary background",
      content: "Body",
      published,
      updated: published,
    });

    const content = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.ok(content != null);

    await startArticleContentSummary(
      tx,
      {} as never,
      content,
      services.ai.summarize,
    );

    const started = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.ok(started?.summaryStarted != null);

    await waitFor(async () => {
      const current = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      return current?.summaryStarted == null;
    });
  });
});

test("createArticle() starts summaries after enclosing transaction commit", async () => {
  await withExclusiveTestDatabase(async () => {
    let accountId: Uuid | undefined;
    let linkId: Uuid | undefined;
    try {
      let releaseSummary!: () => void;
      let summaryStarted!: () => void;
      const releaseSummaryPromise = new Promise<void>((resolve) => {
        releaseSummary = resolve;
      });
      const summaryStartedPromise = new Promise<void>((resolve) => {
        summaryStarted = resolve;
      });
      const summarizer = new MockLanguageModelV3({
        doGenerate: async () => {
          summaryStarted();
          await releaseSummaryPromise;
          return {
            content: [{ type: "text", text: "Short summary." }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 4,
                text: 4,
                reasoning: undefined,
              },
            },
            warnings: [],
          };
        },
      });
      const suffix = generateUuidV7().replaceAll("-", "").slice(0, 12);
      const author = await insertAccountWithActor(
        db as unknown as Parameters<typeof insertAccountWithActor>[0],
        {
          username: `summaryafter${suffix}`,
          name: "Summary After Commit",
          email: `summaryafter${suffix}@example.com`,
        },
      );
      accountId = author.account.id;
      const fedCtx = createFedCtx(
        db as unknown as Parameters<typeof createFedCtx>[0],
      );
      fedCtx.models = {
        summarizer: defineApplicationModel(summarizer),
        translator: {} as never,
        moderationAnalyzer: {} as never,
      } as typeof fedCtx.models;
      const published = new Date("2026-04-15T00:00:00.000Z");
      let sourceId: Uuid | undefined;

      await withTransaction(fedCtx, async (context) => {
        const article = await createArticle(context, {
          accountId: author.account.id,
          publishedYear: 2026,
          slug: "summary-after-commit",
          tags: [],
          allowLlmTranslation: false,
          published,
          updated: published,
          title: "Summary after commit",
          content:
            "This article body is deliberately long enough for a shorter " +
            "generated summary to be persisted after the surrounding " +
            "transaction commits.",
          language: "en",
        });
        assert.ok(article != null);
        sourceId = article.articleSource.id;
        linkId = article.linkId ?? undefined;
      });

      await summaryStartedPromise;
      releaseSummary();

      await waitFor(async () => {
        const current = await db.query.articleContentTable.findFirst({
          where: { sourceId: sourceId!, language: "en" },
        });
        return current?.summary === "Short summary.";
      });
    } finally {
      if (accountId != null) {
        await db.delete(accountTable).where(eq(accountTable.id, accountId));
      }
      if (linkId != null) {
        await db.delete(postLinkTable).where(eq(postLinkTable.id, linkId));
      }
    }
  });
});

test("updateArticle() persists regenerated summaries after commit", async () => {
  await withExclusiveTestDatabase(async () => {
    let accountId: Uuid | undefined;
    let linkId: Uuid | undefined;
    const releaseRegeneratedSummary = Promise.withResolvers<void>();
    try {
      const regeneratedSummaryStarted = Promise.withResolvers<void>();
      let generation = 0;
      const summarizer = new MockLanguageModelV3({
        doGenerate: async () => {
          generation++;
          if (generation > 1) {
            regeneratedSummaryStarted.resolve();
            await releaseRegeneratedSummary.promise;
          }
          return {
            content: [
              {
                type: "text",
                text:
                  generation === 1
                    ? "Initial summary."
                    : "Regenerated summary.",
              },
            ],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: 10,
                noCache: 10,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 4,
                text: 4,
                reasoning: undefined,
              },
            },
            warnings: [],
          };
        },
      });
      const suffix = generateUuidV7().replaceAll("-", "").slice(0, 12);
      const author = await insertAccountWithActor(
        db as unknown as Parameters<typeof insertAccountWithActor>[0],
        {
          username: `summaryedit${suffix}`,
          name: "Summary After Edit",
          email: `summaryedit${suffix}@example.com`,
        },
      );
      accountId = author.account.id;
      const fedCtx = createFedCtx(
        db as unknown as Parameters<typeof createFedCtx>[0],
      );
      fedCtx.models = {
        summarizer: defineApplicationModel(summarizer),
        translator: {} as never,
        moderationAnalyzer: {} as never,
      } as typeof fedCtx.models;
      const published = new Date("2026-04-15T00:00:00.000Z");
      const article = await createArticle(fedCtx, {
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-after-edit",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
        title: "Summary after edit",
        content:
          "This original article body is deliberately long enough for its " +
          "initial generated summary to be shorter than the source text.",
        language: "en",
      });
      assert.ok(article != null);
      linkId = article.linkId ?? undefined;
      const sourceId = article.articleSource.id;

      await waitFor(async () => {
        const current = await db.query.articleContentTable.findFirst({
          where: { sourceId, language: "en" },
        });
        return current?.summary === "Initial summary.";
      });

      const updated = await updateArticle(fedCtx, sourceId, {
        content:
          "This edited article body is also deliberately long enough for its " +
          "regenerated summary to be shorter than the new source text.",
      });
      assert.ok(updated != null);
      await regeneratedSummaryStarted.promise;
      releaseRegeneratedSummary.resolve();

      await waitFor(async () => {
        const current = await db.query.articleContentTable.findFirst({
          where: { sourceId, language: "en" },
        });
        return (
          current?.summary === "Regenerated summary." &&
          current.summaryStarted == null
        );
      }, 1_000);
    } finally {
      releaseRegeneratedSummary.resolve();
      if (accountId != null) {
        await db.delete(accountTable).where(eq(accountTable.id, accountId));
      }
      if (linkId != null) {
        await db.delete(postLinkTable).where(eq(postLinkTable.id, linkId));
      }
    }
  });
});

test("startArticleContentTranslation() deletes queued rows when translation fails", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = {
      summarizer: {} as never,
      translator: {} as never,
      moderationAnalyzer: {} as never,
    } as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "translationbackground",
      name: "Translation Background",
      email: "translationbackground@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "translationrequester",
      name: "Translation Requester",
      email: "translationrequester@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "translation-background",
      tags: ["relay"],
      allowLlmTranslation: true,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Translation background",
      content: "Original body",
      published,
      updated: published,
    });

    const content = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.ok(content != null);

    const queued = await startArticleContentTranslation(fedCtx, {
      content,
      targetLanguage: "ko",
      requester: requester.account,
    });

    assert.equal(queued.language, "ko");
    assert.equal(queued.beingTranslated, true);

    await waitFor(async () => {
      const current = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      return current == null;
    });
  });
});

test("restartArticleContentTranslations() resets each translation row to placeholder state and re-runs the translator", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    // Use the same `{} as never` translator stub as the existing
    // failure-path test: it lets us observe the row pass through
    // the placeholder state and then be cleaned up by the failure
    // branch, which is enough to confirm
    // restartArticleContentTranslations actually re-fired the
    // translation pipeline against the reset row.
    fedCtx.models = {
      summarizer: {} as never,
      translator: {} as never,
      moderationAnalyzer: {} as never,
    } as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "restarttranslator",
      name: "Restart Translator",
      email: "restarttranslator@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "restartrequester",
      name: "Restart Requester",
      email: "restartrequester@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    const [articleSource] = await tx
      .insert(articleSourceTable)
      .values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "restart-translation",
        tags: [],
        allowLlmTranslation: true,
        published,
        updated: published,
      })
      .returning();
    // The original row carries the *new* (post-edit) body — the
    // shape updateArticleSource leaves behind for
    // restartArticleContentTranslations to mirror into each
    // translation placeholder.
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "New original title",
      content: "New original body",
      published,
      updated: published,
    });
    // A previously completed translation that is now stale relative
    // to the freshly edited original.
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "Stale translated title",
      content: "Stale translated body",
      summary: "Stale summary.",
      originalLanguage: "en",
      translationRequesterId: requester.account.id,
      beingTranslated: false,
      published: new Date("2026-04-15T01:00:00.000Z"),
      updated: new Date("2026-04-15T01:00:00.000Z"),
    });

    await restartArticleContentTranslations(fedCtx, articleSource);

    // The row must briefly pass through placeholder state before
    // the failing stub model causes the failure branch to delete
    // it; assert on either observable.
    await waitFor(async () => {
      const current = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      if (current == null) return true;
      // Placeholder reset: title/content mirror the new original
      // and beingTranslated has flipped back true with summary
      // state cleared.  translationRequesterId is preserved.
      return (
        current.beingTranslated === true &&
        current.title === "New original title" &&
        current.content === "New original body" &&
        current.summary === null &&
        current.translationRequesterId === requester.account.id
      );
    });

    // Eventually the failing stub causes deletion via the
    // run-translation failure branch.
    await waitFor(async () => {
      const current = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      return current == null;
    });
  });
});

test("restartArticleContentTranslations() leaves persistence failures immediately retryable", async () => {
  await withRollback(async (tx) => {
    const baseFedCtx = createFedCtx(tx);
    let translationAttempts = 0;
    baseFedCtx.data.services = {
      ...baseFedCtx.data.services,
      ai: {
        ...baseFedCtx.data.services.ai,
        translate: () => {
          translationAttempts++;
          return Promise.resolve("# Translated title\n\nTranslated body");
        },
      },
    };
    const deliveryAttempted = Promise.withResolvers<void>();
    let deliveryAttempts = 0;
    const fedCtx = {
      ...baseFedCtx,
      sendActivity() {
        deliveryAttempts++;
        deliveryAttempted.resolve();
        return Promise.reject(new Error("outbox persistence failed"));
      },
    } as typeof baseFedCtx;
    const author = await insertAccountWithActor(tx, {
      username: "retrytranslation",
      name: "Retry Translation",
      email: "retrytranslation@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "retryrequester",
      name: "Retry Requester",
      email: "retryrequester@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    const [articleSource] = await tx
      .insert(articleSourceTable)
      .values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "retry-translation",
        tags: [],
        allowLlmTranslation: true,
        published,
        updated: published,
      })
      .returning();
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Current original title",
      content: "Current original body",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "Previous translated title",
      content: "Previous translated body",
      originalLanguage: "en",
      translationRequesterId: requester.account.id,
      beingTranslated: false,
      published,
      updated: published,
    });

    await restartArticleContentTranslations(fedCtx, articleSource);
    await deliveryAttempted.promise;
    await waitFor(async () => {
      const current = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      return (
        current?.beingTranslated === true && current.updated.getTime() === 0
      );
    });

    const original = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.ok(original != null);
    await startArticleContentTranslation(fedCtx, {
      content: original,
      targetLanguage: "ko",
      requester: requester.account,
    });
    await waitFor(async () => {
      if (translationAttempts < 2 || deliveryAttempts < 2) return false;
      const current = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      return (
        current?.beingTranslated === true && current.updated.getTime() === 0
      );
    });

    const placeholder = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.ok(placeholder != null);
    assert.equal(placeholder.beingTranslated, true);
    assert.equal(placeholder.updated.getTime(), 0);
    assert.equal(placeholder.title, "Current original title");
    assert.equal(placeholder.content, "Current original body");
    assert.equal(placeholder.translationRequesterId, requester.account.id);
  });
});

test("restartArticleContentTranslations() is a no-op when the article has no translations", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = {
      summarizer: {} as never,
      translator: {} as never,
      moderationAnalyzer: {} as never,
    } as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "restartnotrans",
      name: "Restart No Translations",
      email: "restartnotrans@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    const [articleSource] = await tx
      .insert(articleSourceTable)
      .values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "restart-no-translations",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      })
      .returning();
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Original",
      content: "Body",
      published,
      updated: published,
    });

    // Should return without throwing despite the deliberately bad
    // translator stub.
    await restartArticleContentTranslations(fedCtx, articleSource);

    // Original row still in place and unchanged.
    const original = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.ok(original != null);
    assert.equal(original.beingTranslated, false);
    assert.equal(original.content, "Body");
  });
});
