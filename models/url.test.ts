import assert from "node:assert";
import test from "node:test";
import { compactUrl, getAccountLinkDisplayText } from "./url.ts";

test("compactUrl()", () => {
  assert.deepEqual(compactUrl("https://example.com/"), "example.com");
  assert.deepEqual(compactUrl("https://example.com/test/"), "example.com/test");
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

test("getAccountLinkDisplayText() distinguishes GitHub profiles and repositories", () => {
  assert.equal(
    getAccountLinkDisplayText("https://github.com/hackers-pub", "@hackers-pub"),
    "@hackers-pub",
  );
  assert.equal(
    getAccountLinkDisplayText(
      "https://github.com/hackers-pub/hackerspub",
      "@hackers-pub",
    ),
    "hackers-pub/hackerspub",
  );
  assert.equal(
    getAccountLinkDisplayText(
      "https://github.com/hackers-pub/hackerspub/issues/331",
      "@hackers-pub",
    ),
    "github.com/hackers-pub/hackerspub/issues/331",
  );
  assert.equal(
    getAccountLinkDisplayText("https://example.com/path", "example"),
    "example",
  );
});
