import assert from "node:assert/strict";
import test from "node:test";
import { getNote } from "./objects.ts";
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
