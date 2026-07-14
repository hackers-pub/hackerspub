import assert from "node:assert";
import test from "node:test";
import {
  addPollOption,
  createPollDraft,
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  removePollOption,
  restorePollDraft,
  setPollDuration,
  validatePollDraft,
} from "./pollState.ts";

const NOW = new Date(2026, 6, 14, 12, 34, 56, 789);

function ids(): () => string {
  let id = 0;
  return () => `option-${++id}`;
}

test("createPollDraft creates the minimum options and a rounded one-day deadline", () => {
  assert.deepEqual(createPollDraft(NOW, ids()), {
    enabled: false,
    title: "",
    multiple: false,
    ends: "2026-07-15T12:34",
    options: [
      { localId: "option-1", title: "" },
      { localId: "option-2", title: "" },
    ],
  });
});

test("restorePollDraft disables unavailable polls and repairs too few options", () => {
  assert.deepEqual(
    restorePollDraft(
      {
        enabled: true,
        title: "Question",
        multiple: true,
        ends: "",
        options: [{ localId: "only", title: "One" }],
      },
      false,
      NOW,
      ids(),
    ),
    {
      enabled: false,
      title: "Question",
      multiple: true,
      ends: "2026-07-15T12:34",
      options: [
        { localId: "option-1", title: "" },
        { localId: "option-2", title: "" },
      ],
    },
  );
});

test("poll options stay within the supported bounds", () => {
  let draft = createPollDraft(NOW, ids());
  draft = removePollOption(draft, draft.options[0].localId);
  assert.equal(draft.options.length, MIN_POLL_OPTIONS);

  const createId = ids();
  for (let i = 0; i < MAX_POLL_OPTIONS + 5; i++) {
    draft = addPollOption(draft, createId);
  }
  assert.equal(draft.options.length, MAX_POLL_OPTIONS);

  draft = removePollOption(draft, draft.options[5].localId);
  assert.equal(draft.options.length, MAX_POLL_OPTIONS - 1);
});

test("setPollDuration uses the supplied clock and rounds to a minute", () => {
  assert.equal(setPollDuration(NOW, 7), "2026-07-21T12:34");
});

test("validatePollDraft returns focused validation errors", () => {
  const base = {
    ...createPollDraft(NOW, ids()),
    enabled: true,
    title: " Question ",
    ends: "2026-07-15T12:34",
    options: [
      { localId: "a", title: " Yes " },
      { localId: "b", title: " No " },
    ],
  };

  assert.deepEqual(
    validatePollDraft({ ...base, title: " " }, NOW.getTime()),
    { ok: false, error: "empty-title" },
  );
  assert.deepEqual(
    validatePollDraft({
      ...base,
      options: [{ localId: "a", title: "" }, base.options[1]],
    }, NOW.getTime()),
    { ok: false, error: "empty-option" },
  );
  assert.deepEqual(
    validatePollDraft({
      ...base,
      options: [{ localId: "a", title: "Yes" }],
    }, NOW.getTime()),
    { ok: false, error: "too-few-options" },
  );
  assert.deepEqual(
    validatePollDraft({
      ...base,
      options: [
        { localId: "a", title: "Same" },
        { localId: "b", title: " Same " },
      ],
    }, NOW.getTime()),
    { ok: false, error: "duplicate-options" },
  );
  assert.deepEqual(
    validatePollDraft({ ...base, ends: "2026-02-30T12:00" }, NOW.getTime()),
    { ok: false, error: "invalid-deadline" },
  );
  assert.deepEqual(
    validatePollDraft({ ...base, ends: "2026-07-14T12:34" }, NOW.getTime()),
    { ok: false, error: "deadline-too-soon" },
  );
});

test("validatePollDraft trims a valid poll and serializes its deadline", () => {
  const result = validatePollDraft({
    ...createPollDraft(NOW, ids()),
    enabled: true,
    title: " Question ",
    multiple: true,
    ends: "2026-07-15T12:34",
    options: [
      { localId: "a", title: " Yes " },
      { localId: "b", title: " No " },
    ],
  }, NOW.getTime());

  assert.deepEqual(result, {
    ok: true,
    value: {
      title: "Question",
      multiple: true,
      options: ["Yes", "No"],
      ends: new Date(2026, 6, 15, 12, 34).toISOString(),
    },
  });
});
