import assert from "node:assert/strict";
import test from "node:test";
import { articleContentTable, articleSourceTable } from "./schema.ts";
import {
  startArticleContentSummary,
  startArticleContentTranslation,
} from "./article.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";
import { generateUuidV7 } from "./uuid.ts";

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for async background state");
}

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

    await startArticleContentSummary(tx, {} as never, content);

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

test("startArticleContentTranslation() deletes queued rows when translation fails", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.data.models = {
      summarizer: {} as never,
      translator: {} as never,
    } as typeof fedCtx.data.models;
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
