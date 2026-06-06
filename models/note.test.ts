import assert from "node:assert";
import test from "node:test";
import { updateAccountData } from "./account.ts";
import { createNoteSource, getNoteSource, updateNoteSource } from "./note.ts";
import { mediumTable, noteSourceMediumTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("createNoteSource() and updateNoteSource() round-trip note sources", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "notesourceowner",
      name: "Note Source Owner",
      email: "notesourceowner@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");

    const created = await createNoteSource(tx, {
      accountId: account.account.id,
      visibility: "unlisted",
      content: "Original note source",
      language: "en",
      published,
      updated: published,
    });

    assert.ok(created != null);
    assert.equal(created.accountId, account.account.id);
    assert.equal(created.visibility, "unlisted");
    assert.equal(created.content, "Original note source");
    assert.equal(created.language, "en");

    const updated = await updateNoteSource(tx, created.id, {
      content: "Updated note source",
      language: "ko",
      visibility: "followers",
    });

    assert.ok(updated != null);
    assert.equal(updated.id, created.id);
    assert.equal(updated.content, "Updated note source");
    assert.equal(updated.language, "ko");
    assert.equal(updated.visibility, "followers");
    assert.equal(updated.published.toISOString(), published.toISOString());
    assert.equal(updated.updated.getTime() >= created.updated.getTime(), true);
  });
});

test("getNoteSource() resolves renamed accounts and loads media relations", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "oldnoteuser",
      name: "Old Note User",
      email: "oldnoteuser@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Readable note source",
    });

    const [medium] = await tx.insert(mediumTable).values({
      id: generateUuidV7(),
      key: "note-media/test.webp",
      type: "image/webp",
      width: 320,
      height: 180,
    }).returning();

    await tx.insert(noteSourceMediumTable).values({
      sourceId: noteSourceId,
      index: 0,
      mediumId: medium.id,
      alt: "Readable alt text",
    });

    const renamed = await updateAccountData(tx, {
      id: author.account.id,
      username: "newnoteuser",
    });
    assert.ok(renamed != null);

    const source = await getNoteSource(
      tx,
      "oldnoteuser",
      noteSourceId,
      undefined,
    );

    assert.ok(source != null);
    assert.equal(source.id, noteSourceId);
    assert.equal(source.account.id, author.account.id);
    assert.equal(source.account.username, "newnoteuser");
    assert.equal(source.post.id, post.id);
    assert.equal(source.post.actor.id, author.actor.id);
    assert.equal(source.media.length, 1);
    assert.equal(source.media[0].medium.key, "note-media/test.webp");
    assert.equal(source.media[0].alt, "Readable alt text");
  });
});
