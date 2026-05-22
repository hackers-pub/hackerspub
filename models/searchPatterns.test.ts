import assert from "node:assert/strict";
import test from "node:test";
import { FULL_HANDLE_REGEXP, HANDLE_REGEXP } from "./searchPatterns.ts";

test("HANDLE_REGEXP matches a bare local handle", () => {
  const match = HANDLE_REGEXP.exec("@alice");
  assert.ok(match);
  assert.equal(match[1], "alice");
});

test("HANDLE_REGEXP is case-insensitive on the username", () => {
  const match = HANDLE_REGEXP.exec("@Alice_42");
  assert.ok(match);
  assert.equal(match[1], "Alice_42");
});

test("HANDLE_REGEXP rejects an actor URL whose path ends in @username", () => {
  // Without the leading `^` anchor, this URL would match and the resolver
  // would mistakenly resolve to a same-username local account.
  assert.equal(HANDLE_REGEXP.test("https://buttersc.one/@songbirds"), false);
});

test("HANDLE_REGEXP rejects a fully qualified handle", () => {
  // The host segment contains characters outside `[a-z0-9_]`, but with the
  // anchor in place we also reject inputs that prepend extra characters
  // before the `@`.
  assert.equal(HANDLE_REGEXP.test("@alice@example.com"), false);
});

test("FULL_HANDLE_REGEXP matches a fully qualified handle", () => {
  const match = FULL_HANDLE_REGEXP.exec("@alice@example.com");
  assert.ok(match);
  assert.equal(match[1], "alice");
  assert.equal(match[2], "example.com");
});
