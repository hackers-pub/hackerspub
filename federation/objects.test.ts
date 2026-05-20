import assert from "node:assert/strict";
import test from "node:test";
import { getCreate, getNote } from "./objects.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("getNote() normalizes quote policy for non-public notes", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "normalizedquotenote",
      name: "Normalized Quote Note",
      email: "normalizedquotenote@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      quotePolicy: "everyone",
      content: "Followers-only note",
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
      },
    });
    assert.ok(noteSource != null);

    const note = await getNote(createFedCtx(tx), noteSource);

    assert.equal(
      note.interactionPolicy?.canQuote?.automaticApprovals[0].href,
      `http://localhost/actors/${author.account.id}`,
    );
  });
});

test("getNote() omits quote policy for direct notes", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "directquotenote",
      name: "Direct Quote Note",
      email: "directquotenote@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: author.account,
      visibility: "direct",
      quotePolicy: "self",
      content: "Direct note",
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
      },
    });
    assert.ok(noteSource != null);

    const note = await getNote(createFedCtx(tx), noteSource);

    assert.equal(note.interactionPolicy == null, true);
  });
});

test("getCreate() returns a Create activity with a dereferenceable id", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "createtest",
      name: "Create Test",
      email: "createtest@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "TDD",
    });
    const postWithRels = await tx.query.postTable.findFirst({
      where: { id: post.id },
      with: {
        actor: { with: { account: true } },
        mentions: { with: { actor: true } },
      },
    });
    assert.ok(postWithRels != null && postWithRels.actor.account != null);

    const create = getCreate(createFedCtx(tx), {
      ...postWithRels,
      actor: { ...postWithRels.actor, account: postWithRels.actor.account },
    });

    assert.ok(create.id != null);
    assert.equal(create.id.hash, "");
    assert.equal(create.id.href, `http://localhost/objects/${post.id}`);
  });
});

test("getCreate() sets actor, object, and published correctly", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "createtest2",
      name: "Create Test 2",
      email: "createtest2@example.com",
    });
    const published = new Date("2026-03-01T12:00:00Z");
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Hello",
      published,
    });
    const postWithRels = await tx.query.postTable.findFirst({
      where: { id: post.id },
      with: {
        actor: { with: { account: true } },
        mentions: { with: { actor: true } },
      },
    });
    assert.ok(postWithRels != null && postWithRels.actor.account != null);

    const create = getCreate(createFedCtx(tx), {
      ...postWithRels,
      actor: { ...postWithRels.actor, account: postWithRels.actor.account },
    });

    assert.equal(
      create.actorId?.href,
      `http://localhost/actors/${author.account.id}`,
    );
    assert.equal(
      create.objectId?.href,
      `http://localhost/objects/${post.id}`,
    );
    assert.ok(create.published != null);
  });
});

test("getNote() advertises manual quote approvals", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "manualquotenote",
      name: "Manual Quote Note",
      email: "manualquotenote@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: author.account,
      quotePolicy: "self",
      content: "Manual quote note",
    });
    const noteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: noteSourceId },
      with: {
        account: true,
        media: { with: { medium: true }, orderBy: { index: "asc" } },
      },
    });
    assert.ok(noteSource != null);

    const note = await getNote(createFedCtx(tx), noteSource, {
      quoteRequestPolicy: "everyone",
    });

    assert.equal(
      note.interactionPolicy?.canQuote?.manualApprovals[0].href,
      "https://www.w3.org/ns/activitystreams#Public",
    );
  });
});
