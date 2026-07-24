import assert from "node:assert";
import test from "node:test";
import {
  createDraftFormSnapshot,
  createDraftSaveInput,
  draftFormMatchesSnapshot,
  reconcileDraftSaveResponse,
} from "./draftSaveSnapshot.ts";

test("draft snapshots preserve form whitespace while save inputs are trimmed", () => {
  const snapshot = createDraftFormSnapshot(" Title ", " Body ", [
    "solid",
    "relay",
  ]);

  assert.deepEqual(snapshot, {
    title: " Title ",
    content: " Body ",
    tags: ["solid", "relay"],
  });
  assert.deepEqual(createDraftSaveInput(snapshot), {
    title: "Title",
    content: "Body",
    tags: ["solid", "relay"],
  });
});

test("reconcileDraftSaveResponse keeps whitespace from an unchanged form", () => {
  const submitted = createDraftFormSnapshot("Draft ", "Body", ["solid"]);
  const saved = createDraftFormSnapshot("Draft", "Body", ["solid"]);

  assert.deepEqual(reconcileDraftSaveResponse(submitted, submitted, saved), {
    formReconciled: true,
    baseline: submitted,
  });
});

test("reconcileDraftSaveResponse accepts edits converging to saved values", () => {
  const submitted = createDraftFormSnapshot("Draft ", "Body", ["solid"]);
  const saved = createDraftFormSnapshot("Draft", "Body", ["solid"]);

  assert.deepEqual(reconcileDraftSaveResponse(saved, submitted, saved), {
    formReconciled: true,
    baseline: saved,
  });
});

test("reconcileDraftSaveResponse keeps newer edits dirty", () => {
  const submitted = createDraftFormSnapshot("Draft", "Body", ["solid"]);
  const current = createDraftFormSnapshot("Draft!", "Body", ["solid"]);
  const saved = createDraftFormSnapshot("Draft", "Body", ["solid"]);

  assert.deepEqual(reconcileDraftSaveResponse(current, submitted, saved), {
    formReconciled: false,
    baseline: saved,
  });
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
