import assert from "node:assert";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  articleContentTable,
  articleSourceTable,
  postTable,
} from "./schema.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";
import { generateUuidV7 } from "./uuid.ts";

// Re-runnable SQL block matching drizzle/0097_clear_oversized_summaries.sql.
// Kept in sync intentionally so tests can assert the cleanup behavior even
// though migrations only run once per database.
const CLEANUP_SQL_POST = sql`
UPDATE "post" AS p
SET "summary" = NULL
FROM "article_content" AS ac
WHERE p."article_source_id" = ac."source_id"
  AND p."language" = ac."language"
  AND ac."original_language" IS NULL
  AND ac."summary" IS NOT NULL
  AND char_length(
        regexp_replace(ac."summary", '^[[:space:]]+|[[:space:]]+$', '', 'g')
      ) >= char_length(
        regexp_replace(ac."content", '^[[:space:]]+|[[:space:]]+$', '', 'g')
      )
`;

const CLEANUP_SQL_ARTICLE_CONTENT = sql`
UPDATE "article_content"
SET "summary" = NULL,
    "summary_unnecessary" = TRUE,
    "summary_started" = NULL
WHERE "summary" IS NOT NULL
  AND char_length(
        regexp_replace("summary", '^[[:space:]]+|[[:space:]]+$', '', 'g')
      ) >= char_length(
        regexp_replace("content", '^[[:space:]]+|[[:space:]]+$', '', 'g')
      )
`;

test("0097 cleanup clears summaries that are not shorter than content", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "summarycleanup1",
      name: "Summary Cleanup 1",
      email: "summarycleanup1@example.com",
    });
    const tooLongId = generateUuidV7();
    const goodId = generateUuidV7();
    const tooLongPostId = generateUuidV7();
    const goodPostId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values([
      {
        id: tooLongId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-cleanup-too-long",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      },
      {
        id: goodId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-cleanup-good",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      },
    ]);
    await tx.insert(articleContentTable).values([
      {
        sourceId: tooLongId,
        language: "en",
        title: "Too long summary",
        content: "Hi.",
        summary: "This is much longer than the original article.",
        summaryStarted: published,
        published,
        updated: published,
      },
      {
        sourceId: goodId,
        language: "en",
        title: "Good summary",
        content:
          "This is a long article body with plenty of words " +
          "so that the summary can be much shorter than it.",
        summary: "Short.",
        summaryStarted: published,
        published,
        updated: published,
      },
    ]);
    await tx.insert(postTable).values([
      {
        id: tooLongPostId,
        iri: `https://example.com/posts/${tooLongPostId}`,
        type: "Article",
        actorId: author.actor.id,
        articleSourceId: tooLongId,
        name: "Too long summary",
        contentHtml: "<p>Hi.</p>",
        language: "en",
        summary: "This is much longer than the original article.",
        visibility: "public",
        url: `https://example.com/posts/${tooLongPostId}`,
        published,
        updated: published,
      },
      {
        id: goodPostId,
        iri: `https://example.com/posts/${goodPostId}`,
        type: "Article",
        actorId: author.actor.id,
        articleSourceId: goodId,
        name: "Good summary",
        contentHtml: "<p>Long body</p>",
        language: "en",
        summary: "Short.",
        visibility: "public",
        url: `https://example.com/posts/${goodPostId}`,
        published,
        updated: published,
      },
    ]);

    await tx.execute(CLEANUP_SQL_POST);
    await tx.execute(CLEANUP_SQL_ARTICLE_CONTENT);

    const tooLongAfter = await tx.query.articleContentTable.findFirst({
      where: { sourceId: tooLongId, language: "en" },
    });
    assert.equal(tooLongAfter?.summary, null);
    assert.equal(tooLongAfter?.summaryUnnecessary, true);
    assert.equal(tooLongAfter?.summaryStarted, null);

    const goodAfter = await tx.query.articleContentTable.findFirst({
      where: { sourceId: goodId, language: "en" },
    });
    assert.equal(goodAfter?.summary, "Short.");
    assert.equal(goodAfter?.summaryUnnecessary, false);

    const tooLongPostAfter = await tx.query.postTable.findFirst({
      where: { id: tooLongPostId },
    });
    assert.equal(tooLongPostAfter?.summary, null);

    const goodPostAfter = await tx.query.postTable.findFirst({
      where: { id: goodPostId },
    });
    assert.equal(goodPostAfter?.summary, "Short.");
  });
});

test("0097 cleanup trims whitespace (newlines/tabs) like the runtime check", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "summarycleanupws",
      name: "Summary Cleanup WS",
      email: "summarycleanupws@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "summary-cleanup-ws",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    // Content is "Hi." with surrounding newlines/tabs; summary is
    // exactly the same length as the trimmed content. Without
    // whitespace-aware trimming, a naive comparison treats the content
    // as longer and skips the row.
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Whitespace edges",
      content: "\n\tHi.\n",
      summary: "Hey",
      summaryStarted: published,
      published,
      updated: published,
    });

    await tx.execute(CLEANUP_SQL_ARTICLE_CONTENT);

    const after = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.equal(after?.summary, null);
    assert.equal(after?.summaryUnnecessary, true);
  });
});

test("0097 cleanup does not clear post summaries for translated content", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "summarycleanup2",
      name: "Summary Cleanup 2",
      email: "summarycleanup2@example.com",
    });
    const sourceId = generateUuidV7();
    const postId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "summary-cleanup-translated",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    // Original (English) row with a working summary.
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Translated source",
      content:
        "This is a long article body with plenty of words " +
        "so that the summary can be much shorter than it.",
      summary: "Short summary.",
      summaryStarted: published,
      published,
      updated: published,
    });
    // Translation with a too-long summary; original_language is set.
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "번역된 글",
      content: "안녕.",
      summary: "이 요약은 번역된 원문보다 훨씬 더 깁니다. 정말 깁니다.",
      summaryStarted: published,
      originalLanguage: "en",
      translationRequesterId: author.account.id,
      beingTranslated: false,
      published,
      updated: published,
    });
    // Post is in the original language only; its summary mirrors the
    // English row, so the cleanup must not clear it.
    await tx.insert(postTable).values({
      id: postId,
      iri: `https://example.com/posts/${postId}`,
      type: "Article",
      actorId: author.actor.id,
      articleSourceId: sourceId,
      name: "Translated source",
      contentHtml: "<p>Long body</p>",
      language: "en",
      summary: "Short summary.",
      visibility: "public",
      url: `https://example.com/posts/${postId}`,
      published,
      updated: published,
    });

    await tx.execute(CLEANUP_SQL_POST);
    await tx.execute(CLEANUP_SQL_ARTICLE_CONTENT);

    const koAfter = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(koAfter?.summary, null);
    assert.equal(koAfter?.summaryUnnecessary, true);

    const enAfter = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.equal(enAfter?.summary, "Short summary.");

    const postAfter = await tx.query.postTable.findFirst({
      where: { id: postId },
    });
    // The post mirrors the English row whose summary is good, so it
    // must remain untouched.
    assert.equal(postAfter?.summary, "Short summary.");
  });
});
