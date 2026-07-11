import assert from "node:assert";
import test from "node:test";
import { buildPostTitleExcerpt } from "./postTitleExcerpt.ts";

test("buildPostTitleExcerpt() tolerates a missing Relay field", () => {
  assert.equal(buildPostTitleExcerpt(undefined, true), "");
});

test("buildPostTitleExcerpt() truncates notes by grapheme", () => {
  assert.equal(buildPostTitleExcerpt("가나다라마바사", true, 5), "가나다라…");
});

test("buildPostTitleExcerpt() leaves article excerpts intact", () => {
  assert.equal(
    buildPostTitleExcerpt("  Article\n excerpt  ", false),
    "  Article\n excerpt  ",
  );
});
