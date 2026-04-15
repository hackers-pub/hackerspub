import assert from "node:assert/strict";
import test from "node:test";
import { deleteArticleDraft, updateArticleDraft } from "./article.ts";
import { generateUuidV7 } from "./uuid.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";

test("updateArticleDraft() creates and updates drafts with normalized tags", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "articledraftowner",
      name: "Article Draft Owner",
      email: "articledraftowner@example.com",
    });
    const draftId = generateUuidV7();

    const created = await updateArticleDraft(tx, {
      id: draftId,
      accountId: account.account.id,
      title: "Draft title",
      content: "Draft content",
      tags: ["  #fediverse  ", "#fediverse", "solid", "", "bad,tag"],
    });

    assert.equal(created.id, draftId);
    assert.deepEqual(created.tags, ["fediverse", "solid"]);

    const updated = await updateArticleDraft(tx, {
      id: draftId,
      accountId: account.account.id,
      title: "Updated title",
      content: "Updated content",
      tags: ["  #relay", "relay", "graphql "],
    });

    assert.equal(updated.id, draftId);
    assert.equal(updated.title, "Updated title");
    assert.equal(updated.content, "Updated content");
    assert.deepEqual(updated.tags, ["relay", "graphql"]);
    assert.equal(updated.updated.getTime() >= created.updated.getTime(), true);
  });
});

test("deleteArticleDraft() only deletes drafts owned by the account", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "draftdeleteowner",
      name: "Draft Delete Owner",
      email: "draftdeleteowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "draftdeleteother",
      name: "Draft Delete Other",
      email: "draftdeleteother@example.com",
    });
    const draft = await updateArticleDraft(tx, {
      id: generateUuidV7(),
      accountId: owner.account.id,
      title: "Owned draft",
      content: "Owned content",
      tags: [],
    });

    const wrongAccountDelete = await deleteArticleDraft(
      tx,
      other.account.id,
      draft.id,
    );
    assert.equal(wrongAccountDelete, undefined);

    const deleted = await deleteArticleDraft(tx, owner.account.id, draft.id);
    assert.ok(deleted != null);
    assert.equal(deleted.id, draft.id);

    const stored = await tx.query.articleDraftTable.findFirst({
      where: { id: draft.id },
    });
    assert.equal(stored, undefined);
  });
});
