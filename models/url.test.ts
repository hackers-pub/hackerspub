import assert from "node:assert/strict";
import test from "node:test";
import { compactUrl } from "./url.ts";

test("compactUrl()", () => {
  assert.deepEqual(
    compactUrl("https://example.com/"),
    "example.com",
  );
  assert.deepEqual(
    compactUrl("https://example.com/test/"),
    "example.com/test",
  );
  assert.deepEqual(
    compactUrl("https://example.com/test/?"),
    "example.com/test",
  );
  assert.deepEqual(
    compactUrl("https://example.com/test/?#"),
    "example.com/test",
  );
  assert.deepEqual(
    compactUrl("https://example.com/test/?#asdf"),
    "example.com/test/#asdf",
  );
});
