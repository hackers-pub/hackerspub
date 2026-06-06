import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  accountTable,
  articleContentTable,
  articleSourceTable,
  mediumTable,
  noteSourceTable,
  postTable,
} from "./schema.ts";
import { syncPostFromArticleSource, syncPostFromNoteSource } from "./post.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
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
        account: { with: { avatarMedium: true, emails: true, links: true } },
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
        account: { with: { avatarMedium: true, emails: true, links: true } },
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

test("syncPostFromNoteSource() preserves remote quote authorizations", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "syncquoteauthowner",
      name: "Sync Quote Auth Owner",
      email: "syncquoteauthowner@example.com",
    });
    const quotedActor = await insertRemoteActor(tx, {
      username: "syncquoteauthremote",
      name: "Sync Quote Auth Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: quotedActor.id,
      contentHtml: "<p>Remote quote target</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const noteSourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    await tx.insert(noteSourceTable).values({
      id: noteSourceId,
      accountId: author.account.id,
      visibility: "public",
      content: "Quote with accepted authorization",
      language: "en",
      published,
      updated: published,
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: { with: { avatarMedium: true, emails: true, links: true } },
        media: { with: { medium: true } },
      },
    });
    assert.ok(noteSource != null);

    const created = await syncPostFromNoteSource(fedCtx, noteSource, {
      quotedPost: { ...quotedPost, actor: quotedActor },
    });
    assert.ok(created != null);
    assert.equal(created.quoteAuthorizationIri, null);

    const authorizationIri =
      "https://remote.example/quote-authorizations/sync-preserve";
    await tx.update(postTable)
      .set({
        quotedPostId: quotedPost.id,
        quoteAuthorizationIri: authorizationIri,
      })
      .where(eq(postTable.id, created.id));
    await tx.update(noteSourceTable)
      .set({
        content: "Edited quote with accepted authorization",
        updated: new Date("2026-04-15T01:00:00.000Z"),
      })
      .where(eq(noteSourceTable.id, noteSourceId));
    const updatedSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: { with: { avatarMedium: true, emails: true, links: true } },
        media: { with: { medium: true } },
      },
    });
    assert.ok(updatedSource != null);

    const updated = await syncPostFromNoteSource(fedCtx, updatedSource, {
      quotedPost: { ...quotedPost, actor: quotedActor },
    });

    assert.ok(updated != null);
    assert.equal(updated.id, created.id);
    assert.equal(updated.quotedPostId, quotedPost.id);
    assert.equal(updated.quoteAuthorizationIri, authorizationIri);
  });
});

test("syncPostFromNoteSource() preserves quotes when relations are omitted", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "syncquotepreserveowner",
      name: "Sync Quote Preserve Owner",
      email: "syncquotepreserveowner@example.com",
    });
    const quotedAuthor = await insertAccountWithActor(tx, {
      username: "syncquotepreservetarget",
      name: "Sync Quote Preserve Target",
      email: "syncquotepreservetarget@example.com",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: quotedAuthor.account,
      content: "Target that should remain quoted",
    });
    const noteSourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    await tx.insert(noteSourceTable).values({
      id: noteSourceId,
      accountId: author.account.id,
      visibility: "public",
      content: "Initial quote",
      language: "en",
      published,
      updated: published,
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: { with: { avatarMedium: true, emails: true, links: true } },
        media: { with: { medium: true } },
      },
    });
    assert.ok(noteSource != null);

    const created = await syncPostFromNoteSource(fedCtx, noteSource, {
      quotedPost: { ...quotedPost, actor: quotedAuthor.actor },
    });
    assert.ok(created != null);
    assert.equal(created.quotedPostId, quotedPost.id);
    assert.ok(created.quoteAuthorizationIri != null);

    await tx.update(noteSourceTable)
      .set({
        content: "Edited quote body",
        updated: new Date("2026-04-15T01:00:00.000Z"),
      })
      .where(eq(noteSourceTable.id, noteSourceId));
    const updatedSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: { with: { avatarMedium: true, emails: true, links: true } },
        media: { with: { medium: true } },
      },
    });
    assert.ok(updatedSource != null);

    const updated = await syncPostFromNoteSource(fedCtx, updatedSource);

    assert.ok(updated != null);
    assert.equal(updated.id, created.id);
    assert.equal(updated.quotedPostId, quotedPost.id);
    assert.equal(updated.quoteAuthorizationIri, created.quoteAuthorizationIri);
    assert.equal(updated.quotedPost?.id, quotedPost.id);
    const quotedAfterUpdate = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.equal(quotedAfterUpdate?.quotesCount, 1);
  });
});

test("syncPostFromNoteSource() omits authorization for self-quotes", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "syncselfquoteowner",
      name: "Sync Self Quote Owner",
      email: "syncselfquoteowner@example.com",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Own quote target",
    });
    const noteSourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    await tx.insert(noteSourceTable).values({
      id: noteSourceId,
      accountId: author.account.id,
      visibility: "public",
      content: "Self quote",
      language: "en",
      published,
      updated: published,
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: { with: { avatarMedium: true, emails: true, links: true } },
        media: { with: { medium: true } },
      },
    });
    assert.ok(noteSource != null);

    const created = await syncPostFromNoteSource(fedCtx, noteSource, {
      quotedPost: { ...quotedPost, actor: author.actor },
    });

    assert.ok(created != null);
    assert.equal(created.quotedPostId, quotedPost.id);
    assert.equal(created.quoteAuthorizationIri, null);
    const authorization = await tx.query.quoteAuthorizationTable.findFirst({
      where: { quotePostId: created.id },
    });
    assert.equal(authorization, undefined);
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
    const avatarMediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: avatarMediumId,
      key: "avatars/sync-note-owner.webp",
      type: "image/webp",
      width: 2,
      height: 2,
    });
    await tx.update(accountTable)
      .set({ avatarMediumId })
      .where(eq(accountTable.id, author.account.id));

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
        account: { with: { avatarMedium: true, emails: true, links: true } },
        media: { with: { medium: true } },
      },
    });
    assert.ok(noteSource != null);

    const created = await syncPostFromNoteSource(fedCtx, noteSource, {
      quotedPost: { ...quotedPost, actor: quotedAuthor.actor },
    });

    assert.ok(created != null);
    assert.equal(created.noteSourceId, noteSourceId);
    assert.equal(created.quotedPost?.id, quotedPost.id);
    assert.equal(
      created.actor.avatarUrl,
      "http://localhost/media/avatars/sync-note-owner.webp",
    );
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
        account: { with: { avatarMedium: true, emails: true, links: true } },
        media: { with: { medium: true } },
      },
    });
    assert.ok(updatedSource != null);

    const updated = await syncPostFromNoteSource(fedCtx, updatedSource, {
      quotedPost: { ...quotedPost, actor: quotedAuthor.actor },
    });

    assert.ok(updated != null);
    assert.equal(updated.id, created.id);
    assert.match(updated.contentHtml, /Updated note body/);

    const quotedAfterUpdate = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.ok(quotedAfterUpdate != null);
    assert.equal(quotedAfterUpdate.quotesCount, 1);
  });
});
