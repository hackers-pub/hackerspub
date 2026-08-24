import assert from "node:assert";
import test from "node:test";
import { reactionMutationSucceeded } from "./reactionMutationResult.ts";

test("accepts successful add and remove reaction payloads", () => {
  assert.equal(
    reactionMutationSucceeded("add", {
      __typename: "AddReactionToPostPayload",
      reaction: { id: "reaction-id" },
    }),
    true,
  );
  assert.equal(
    reactionMutationSucceeded("remove", {
      __typename: "RemoveReactionFromPostPayload",
      success: true,
    }),
    true,
  );
});

test("rejects reaction mutation error union members", () => {
  assert.equal(
    reactionMutationSucceeded("add", {
      __typename: "NotAuthenticatedError",
    }),
    false,
  );
  assert.equal(
    reactionMutationSucceeded("remove", {
      __typename: "InvalidInputError",
    }),
    false,
  );
});

test("rejects incomplete success payloads", () => {
  assert.equal(
    reactionMutationSucceeded("add", {
      __typename: "AddReactionToPostPayload",
      reaction: null,
    }),
    false,
  );
  assert.equal(
    reactionMutationSucceeded("remove", {
      __typename: "RemoveReactionFromPostPayload",
      success: false,
    }),
    false,
  );
  assert.equal(reactionMutationSucceeded("add", null), false);
});
