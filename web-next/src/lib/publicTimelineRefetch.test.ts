import assert from "node:assert/strict";
import test from "node:test";
import { createPublicTimelineRefetchTracker } from "./publicTimelineRefetch.ts";

test("the public timeline skips a refetch when its seed is still current", () => {
  const shouldRefetch = createPublicTimelineRefetchTracker({
    actingAccountId: "account-a",
    language: "ko",
  });

  assert.equal(
    shouldRefetch({ actingAccountId: "account-a", language: "ko" }),
    false,
  );
});

test("the public timeline catches an account change before its first effect", () => {
  const shouldRefetch = createPublicTimelineRefetchTracker({
    actingAccountId: "account-a",
    language: undefined,
  });

  assert.equal(
    shouldRefetch({ actingAccountId: "account-b", language: undefined }),
    true,
  );
  assert.equal(
    shouldRefetch({ actingAccountId: "account-b", language: undefined }),
    false,
  );
});

test("the public timeline continues to observe language changes", () => {
  const shouldRefetch = createPublicTimelineRefetchTracker({
    actingAccountId: null,
    language: undefined,
  });

  assert.equal(shouldRefetch({ actingAccountId: null, language: "en" }), true);
});
