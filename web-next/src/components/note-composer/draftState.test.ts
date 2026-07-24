import assert from "node:assert";
import test from "node:test";
import {
  createNoteDraftData,
  decideExternalDraftChange,
  getNoteComposerDraftScope,
  hasUnstorableDraftMedia,
  shouldPreserveCurrentDraftForm,
  toStorableNoteDraftData,
} from "./draftState.ts";

const poll = {
  enabled: false,
  title: "",
  multiple: false,
  ends: "2026-07-15T12:00",
  options: [
    { localId: "a", title: "" },
    { localId: "b", title: "" },
  ],
};

test("getNoteComposerDraftScope follows composer scope precedence", () => {
  assert.equal(getNoteComposerDraftScope({ editingNoteId: "edit" }), null);
  assert.deepEqual(
    getNoteComposerDraftScope({
      replyTargetId: "reply",
      quotedPostId: "quote",
      ensureLinkUrl: "https://example.com/",
      initialContent: "prefill",
    }),
    { type: "reply", targetId: "reply" },
  );
  assert.deepEqual(getNoteComposerDraftScope({ quotedPostId: "quote" }), {
    type: "quote",
    targetId: "quote",
  });
  assert.deepEqual(
    getNoteComposerDraftScope({ ensureLinkUrl: "https://example.com/" }),
    { type: "link", url: "https://example.com/" },
  );
  assert.deepEqual(getNoteComposerDraftScope({ initialContent: " prefill " }), {
    type: "prefill",
    content: "prefill",
  });
  assert.deepEqual(getNoteComposerDraftScope({}), { type: "new" });
});

test("createNoteDraftData stores only stable uploaded media", () => {
  const draft = createNoteDraftData({
    content: "hello",
    language: "en",
    visibility: "PUBLIC",
    quotePolicy: "EVERYONE",
    actingAccountKey: "personal",
    quotedPostId: "quote",
    replyTargetId: "reply",
    ensureLinkUrl: "https://example.com/",
    media: [
      {
        localId: "uploaded",
        previewUrl: "blob:uploaded",
        alt: "diagram",
        mediumRelayId: "relay-medium",
        uuid: "00000000-0000-0000-0000-000000000000",
        url: "https://example.com/media.webp",
        width: 100,
        height: 50,
        uploading: false,
      },
      {
        localId: "pending",
        previewUrl: "blob:pending",
        alt: "pending",
        uploading: true,
      },
    ],
    poll,
    updated: "2026-07-14T00:00:00.000Z",
  });

  assert.deepEqual(draft.media, [
    {
      localId: "uploaded",
      mediumRelayId: "relay-medium",
      uuid: "00000000-0000-0000-0000-000000000000",
      url: "https://example.com/media.webp",
      alt: "diagram",
      width: 100,
      height: 50,
    },
  ]);
  assert.equal(
    hasUnstorableDraftMedia([
      {
        localId: "pending",
        previewUrl: "blob:pending",
        alt: "pending",
        uploading: true,
      },
    ]),
    true,
  );
});

test("toStorableNoteDraftData clears non-dirty transient form data", () => {
  const draft = createNoteDraftData({
    content: "reply mention prefill",
    visibility: "PUBLIC",
    quotePolicy: "EVERYONE",
    actingAccountKey: "personal",
    media: [],
    poll: { ...poll, enabled: true },
    updated: "2026-07-14T00:00:00.000Z",
  });

  assert.deepEqual(toStorableNoteDraftData(draft, false), {
    ...draft,
    content: "",
    media: [],
    poll: { ...draft.poll, enabled: false },
  });
  assert.equal(toStorableNoteDraftData(draft, true), draft);
});

test("shouldPreserveCurrentDraftForm protects dirty scope transitions only", () => {
  assert.equal(
    shouldPreserveCurrentDraftForm({
      previousLoadedKey: "old",
      formDraftKey: "old",
      nextKey: "new",
      dirty: true,
    }),
    true,
  );
  assert.equal(
    shouldPreserveCurrentDraftForm({
      previousLoadedKey: "old",
      formDraftKey: "other",
      nextKey: "new",
      dirty: true,
    }),
    false,
  );
  assert.equal(
    shouldPreserveCurrentDraftForm({
      previousLoadedKey: "old",
      formDraftKey: "old",
      nextKey: "new",
      dirty: false,
    }),
    false,
  );
});

test("decideExternalDraftChange ignores unrelated changes and protects dirty text", () => {
  assert.equal(
    decideExternalDraftChange({
      sameOrigin: true,
      changeKey: "draft",
      currentKey: "draft",
      dirty: false,
    }),
    "ignore",
  );
  assert.equal(
    decideExternalDraftChange({
      sameOrigin: false,
      changeKey: "other",
      currentKey: "draft",
      dirty: false,
    }),
    "ignore",
  );
  assert.equal(
    decideExternalDraftChange({
      sameOrigin: false,
      changeKey: "draft",
      currentKey: "draft",
      dirty: false,
    }),
    "load",
  );
  assert.equal(
    decideExternalDraftChange({
      sameOrigin: false,
      changeKey: "draft",
      currentKey: "draft",
      dirty: true,
    }),
    "preserve-and-resave",
  );
});
