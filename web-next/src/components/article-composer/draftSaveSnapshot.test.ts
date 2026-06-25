import assert from "node:assert";
import test from "node:test";
import {
  createDraftFormSnapshot,
  draftFormMatchesSnapshot,
} from "./draftSaveSnapshot.ts";

test("createDraftFormSnapshot trims saved title and content", () => {
  assert.deepEqual(
    createDraftFormSnapshot(" Title ", " Body ", ["solid", "relay"]),
    {
      title: "Title",
      content: "Body",
      tags: ["solid", "relay"],
    },
  );
});

test("draftFormMatchesSnapshot detects edits made while a save is in flight", () => {
  const submitted = createDraftFormSnapshot("Draft", "Body", ["solid"]);

  assert.equal(
    draftFormMatchesSnapshot(
      createDraftFormSnapshot("Draft!", "Body", ["solid"]),
      submitted,
    ),
    false,
  );
  assert.equal(
    draftFormMatchesSnapshot(
      createDraftFormSnapshot("Draft", "Body", ["solid", "relay"]),
      submitted,
    ),
    false,
  );
  assert.equal(
    draftFormMatchesSnapshot(
      createDraftFormSnapshot("Draft", "Body", ["solid"]),
      submitted,
    ),
    true,
  );
});
