import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@fedify/fedify";
import type { ContextData } from "./context.ts";
import type { Transaction } from "./db.ts";
import { createNote, updateNote } from "./note.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

test("createNote() creates a post and timeline entry for the author", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "createnoteauthor",
      name: "Create Note Author",
      email: "createnoteauthor@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");

    const note = await createNote(
      fedCtx as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        content: "Hello **world**",
        language: "en",
        media: [],
        published,
        updated: published,
      },
    );

    assert.ok(note != null);
    assert.equal(note.noteSource.accountId, author.account.id);
    assert.equal(note.noteSource.content, "Hello **world**");
    assert.equal(note.actor.id, author.actor.id);
    assert.equal(note.noteSourceId, note.noteSource.id);
    assert.match(note.contentHtml, /<strong>world<\/strong>/);
    assert.deepEqual(note.media, []);

    const timelineItem = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: author.account.id,
        postId: note.id,
      },
    });
    assert.ok(timelineItem != null);
    assert.equal(timelineItem.originalAuthorId, author.actor.id);
    assert.equal(timelineItem.lastSharerId, null);
    assert.equal(timelineItem.sharersCount, 0);
  });
});

test("updateNote() updates the persisted post for an existing note source", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "updatenoteauthor",
      name: "Update Note Author",
      email: "updatenoteauthor@example.com",
    });
    const original = await createNote(
      fedCtx as unknown as Context<ContextData<Transaction>>,
      {
        accountId: author.account.id,
        visibility: "public",
        content: "Original note body",
        language: "en",
        media: [],
        published: new Date("2026-04-15T00:00:00.000Z"),
        updated: new Date("2026-04-15T00:00:00.000Z"),
      },
    );
    assert.ok(original != null);

    const updated = await updateNote(fedCtx, original.noteSource.id, {
      content: "Updated _note_ body",
      language: "ko",
    });

    assert.ok(updated != null);
    assert.equal(updated.id, original.id);
    assert.equal(updated.noteSource.id, original.noteSource.id);
    assert.equal(updated.noteSource.content, "Updated _note_ body");
    assert.equal(updated.noteSource.language, "ko");
    assert.match(updated.contentHtml, /<em>note<\/em>/);

    const storedPost = await tx.query.postTable.findFirst({
      where: { id: original.id },
    });
    assert.ok(storedPost != null);
    assert.equal(storedPost.noteSourceId, original.noteSource.id);
    assert.equal(storedPost.language, "ko");
    assert.match(storedPost.contentHtml, /<em>note<\/em>/);
  });
});
