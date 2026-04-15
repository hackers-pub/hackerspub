import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  articleContentTable,
  articleSourceTable,
  noteSourceTable,
} from "./schema.ts";
import { syncPostFromArticleSource, syncPostFromNoteSource } from "./post.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("syncPostFromArticleSource() upserts the post when source content changes", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "syncarticleowner",
      name: "Sync Article Owner",
      email: "syncarticleowner@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "sync-article",
      tags: ["relay"],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Original article",
      content: "Original body with #Relay",
      published,
      updated: published,
    });

    const source = await tx.query.articleSourceTable.findFirst({
      where: { id: sourceId },
      with: {
        account: { with: { emails: true, links: true } },
        contents: true,
      },
    });
    assert.ok(source != null);

    const created = await syncPostFromArticleSource(fedCtx, source);

    assert.equal(created.articleSourceId, sourceId);
    assert.equal(created.name, "Original article");
    assert.match(created.contentHtml, /Original body/);
    assert.ok("relay" in created.tags);

    await tx.update(articleContentTable)
      .set({ title: "Updated article", content: "Updated body" })
      .where(eq(articleContentTable.sourceId, sourceId));
    await tx.update(articleSourceTable)
      .set({ updated: new Date("2026-04-15T01:00:00.000Z") })
      .where(eq(articleSourceTable.id, sourceId));

    const updatedSource = await tx.query.articleSourceTable.findFirst({
      where: { id: sourceId },
      with: {
        account: { with: { emails: true, links: true } },
        contents: true,
      },
    });
    assert.ok(updatedSource != null);

    const updated = await syncPostFromArticleSource(fedCtx, updatedSource);

    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "Updated article");
    assert.match(updated.contentHtml, /Updated body/);
  });
});

test("syncPostFromNoteSource() upserts note posts and updates quote counts", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "syncnoteowner",
      name: "Sync Note Owner",
      email: "syncnoteowner@example.com",
    });
    const quotedAuthor = await insertAccountWithActor(tx, {
      username: "quotedowner",
      name: "Quoted Owner",
      email: "quotedowner@example.com",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: quotedAuthor.account,
      content: "Quoted target",
    });

    const noteSourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    await tx.insert(noteSourceTable).values({
      id: noteSourceId,
      accountId: author.account.id,
      visibility: "public",
      content: "Hello #HackersPub",
      language: "en",
      published,
      updated: published,
    });

    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: { with: { emails: true, links: true } },
        media: true,
      },
    });
    assert.ok(noteSource != null);

    const created = await syncPostFromNoteSource(fedCtx, noteSource, {
      quotedPost: { ...quotedPost, actor: quotedAuthor.actor },
    });

    assert.equal(created.noteSourceId, noteSourceId);
    assert.equal(created.quotedPost?.id, quotedPost.id);
    assert.ok("hackerspub" in created.tags);

    const quotedAfterCreate = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.ok(quotedAfterCreate != null);
    assert.equal(quotedAfterCreate.quotesCount, 1);

    await tx.update(noteSourceTable)
      .set({ content: "Updated note body" })
      .where(eq(noteSourceTable.id, noteSourceId));

    const updatedSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: { with: { emails: true, links: true } },
        media: true,
      },
    });
    assert.ok(updatedSource != null);

    const updated = await syncPostFromNoteSource(fedCtx, updatedSource, {
      quotedPost: { ...quotedPost, actor: quotedAuthor.actor },
    });

    assert.equal(updated.id, created.id);
    assert.match(updated.contentHtml, /Updated note body/);

    const quotedAfterUpdate = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.ok(quotedAfterUpdate != null);
    assert.equal(quotedAfterUpdate.quotesCount, 1);
  });
});
