import assert from "node:assert";
import test from "node:test";
import { eq, and } from "drizzle-orm";
import {
  articleContentTable,
  articleSourceRevisionTable,
  articleSourceTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { getPublishedTranslationMetadata } from "./article-translation-metadata.ts";
import { postgres } from "../test/database.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";

test("published translation metadata does not reload bodies or private drafts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "translationmetadata",
      name: "Translation Metadata",
      email: "translationmetadata@example.com",
    });
    const sourceId = generateUuidV7();
    const currentId = generateUuidV7();
    const oldId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00Z");
    const updated = new Date("2026-04-16T00:00:00Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "translationmetadata",
      published,
      updated,
    });
    await tx.insert(articleSourceRevisionTable).values([
      {
        id: currentId,
        sourceId,
        language: "en",
        title: "Current",
        content: "Current body".repeat(10000),
      },
      {
        id: oldId,
        sourceId,
        language: "en",
        title: "Old",
        content: "Old body".repeat(10000),
        publicUntil: published,
      },
    ]);
    await tx.insert(articleContentTable).values([
      {
        sourceId,
        language: "en",
        title: "Current",
        content: "Current body".repeat(10000),
        sourceRevisionId: currentId,
        published,
        updated,
      },
      {
        sourceId,
        language: "ko",
        originalLanguage: "en",
        provenance: "human",
        title: "Current translation",
        content: "Translation",
        sourceRevisionId: currentId,
        published,
        updated,
      },
      {
        sourceId,
        language: "ja",
        originalLanguage: "en",
        provenance: "human",
        title: "Old translation",
        content: "Translation",
        sourceRevisionId: oldId,
        published,
        updated,
      },
      {
        sourceId,
        language: "fr",
        originalLanguage: "en",
        provenance: "llm",
        title: "Machine translation",
        content: "Translation",
        sourceRevisionId: oldId,
        published,
        updated,
      },
      {
        sourceId,
        language: "de",
        originalLanguage: "en",
        provenance: "unknown",
        title: "Legacy translation",
        content: "Translation",
        published,
        updated,
      },
    ]);
    const source = await tx.query.articleSourceTable.findFirst({
      where: { id: sourceId },
      with: { contents: true },
    });
    assert.ok(source);
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      const metadata = await getPublishedTranslationMetadata(
        tx,
        source,
        source.contents,
      );
      assert.equal(metadata.get("ko")?.reviewState, "current");
      assert.equal(
        metadata.get("ko")?.sourceUpdated?.toISOString(),
        updated.toISOString(),
      );
      assert.equal(metadata.get("ja")?.reviewState, "needsReview");
      assert.equal(
        metadata.get("ja")?.sourceUpdated?.toISOString(),
        published.toISOString(),
      );
      assert.equal(metadata.get("fr")?.reviewState, "needsReview");
      assert.equal(metadata.get("fr")?.sourceUpdated, null);
      assert.equal(metadata.get("de")?.reviewState, "unknownBaseline");
      assert.equal(metadata.get("de")?.sourceUpdated, null);
      assert.equal(
        queries.length,
        2,
        "Metadata needs only the revision pointer and baseline dates",
      );
      await tx
        .update(articleContentTable)
        .set({ sourceRevisionId: null })
        .where(
          and(
            eq(articleContentTable.sourceId, sourceId),
            eq(articleContentTable.language, "en"),
          ),
        );
      const legacy = await getPublishedTranslationMetadata(
        tx,
        source,
        source.contents,
      );
      for (const value of legacy.values()) {
        assert.equal(value.reviewState, "unknownBaseline");
        assert.equal(value.sourceUpdated, null);
      }
      assert.ok(queries.length > 0);
      assert.ok(
        queries.every(
          (query) =>
            !query.includes('"content"') &&
            !query.includes('"article_translation_draft"'),
        ),
        "Public metadata must not read original bodies or private editor drafts",
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});
