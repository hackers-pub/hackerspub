import assert from "node:assert";
import test from "node:test";
import { USERNAME_REGEXP, validateUsername } from "./userValidation.ts";

test("validateUsername accepts database-length usernames", () => {
  const username = "a".repeat(50);

  assert.equal(USERNAME_REGEXP.test(username), true);
  assert.equal(validateUsername(username), null);
});

test("validateUsername rejects usernames longer than the database limit", () => {
  assert.equal(USERNAME_REGEXP.test("a".repeat(51)), false);
  assert.equal(validateUsername("a".repeat(51)), "USERNAME_TOO_LONG");
});
