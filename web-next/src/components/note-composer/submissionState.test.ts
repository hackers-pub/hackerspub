import assert from "node:assert";
import test from "node:test";
import {
  buildCreatePostInput,
  buildUpdateNoteInput,
  getNoteInternalHref,
  validateSubmission,
} from "./submissionState.ts";

const uploadedMedia = [{
  uuid: "00000000-0000-0000-0000-000000000000",
  alt: " Diagram ",
  uploading: false,
}] as const;

test("validateSubmission rejects empty content and incomplete media", () => {
  assert.deepEqual(validateSubmission(" ", []), {
    ok: false,
    error: "empty-content",
  });
  assert.deepEqual(
    validateSubmission("hello", [{
      ...uploadedMedia[0],
      uploading: true,
    }]),
    {
      ok: false,
      error: "uploading-media",
    },
  );
  assert.deepEqual(
    validateSubmission("hello", [{
      alt: "Diagram",
      uploading: false,
    }]),
    {
      ok: false,
      error: "failed-media-upload",
    },
  );
  assert.deepEqual(
    validateSubmission("hello", [{
      ...uploadedMedia[0],
      alt: " ",
    }]),
    {
      ok: false,
      error: "missing-alt",
    },
  );
  assert.deepEqual(validateSubmission(" hello ", uploadedMedia), {
    ok: true,
    content: "hello",
    media: uploadedMedia,
  });
});

test("buildCreatePostInput normalizes shared note fields", () => {
  assert.deepEqual(
    buildCreatePostInput({
      content: " Opinion ",
      ensureLinkUrl: "https://example.com/story",
      language: undefined,
      fallbackLanguage: "ko",
      visibility: "PUBLIC",
      quotePolicy: "EVERYONE",
      quotedPostId: "quote",
      replyTargetId: "reply",
      actingAccountInput: { actingAccountId: "account" },
      media: uploadedMedia,
    }),
    {
      content: "Opinion\n\nhttps://example.com/story",
      language: "ko",
      visibility: "PUBLIC",
      quotePolicy: "EVERYONE",
      quotedPostId: "quote",
      replyTargetId: "reply",
      actingAccountId: "account",
      media: [{
        mediumId: "00000000-0000-0000-0000-000000000000",
        alt: "Diagram",
      }],
    },
  );
});

test("buildUpdateNoteInput includes quote policy only for applicable visibility", () => {
  assert.deepEqual(
    buildUpdateNoteInput({
      noteId: "note",
      content: " Edited ",
      language: undefined,
      quotePolicy: "FOLLOWERS",
      visibility: "FOLLOWERS",
      actingAccountId: "author",
    }),
    {
      noteId: "note",
      content: "Edited",
      language: null,
      actingAccountId: "author",
    },
  );
  assert.equal(
    buildUpdateNoteInput({
      noteId: "note",
      content: "Edited",
      language: "en",
      quotePolicy: "FOLLOWERS",
      visibility: "UNLISTED",
    }).quotePolicy,
    "FOLLOWERS",
  );
});

test("getNoteInternalHref uses local usernames and remote handles", () => {
  assert.equal(
    getNoteInternalHref({
      uuid: "uuid",
      sourceId: "source",
      actor: {
        local: true,
        username: "alice",
        handle: "@alice@example.com",
      },
    }),
    "/@alice/source",
  );
  assert.equal(
    getNoteInternalHref({
      uuid: "uuid",
      sourceId: null,
      actor: {
        local: false,
        username: "alice",
        handle: "@alice@example.com",
      },
    }),
    "/@alice@example.com/uuid",
  );
});
