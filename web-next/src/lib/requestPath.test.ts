import assert from "node:assert";
import test from "node:test";
import { hasMalformedPathEncoding } from "./requestPath.ts";

test("hasMalformedPathEncoding() rejects invalid percent-encoded bytes", () => {
  assert.equal(hasMalformedPathEncoding("/%c0/"), true);
  assert.equal(hasMalformedPathEncoding("/%FF_dev_test"), true);
  assert.equal(hasMalformedPathEncoding("/truncated-%E0%A4"), true);
});

test("hasMalformedPathEncoding() accepts valid encoded paths", () => {
  assert.equal(hasMalformedPathEncoding("/"), false);
  assert.equal(hasMalformedPathEncoding("/%ED%95%9C%EA%B8%80"), false);
  assert.equal(hasMalformedPathEncoding("/literal%2520percent"), false);
});
