import assert from "node:assert";
import test from "node:test";
import { getValidLocaleBaseNames } from "./locales.ts";

test("getValidLocaleBaseNames() drops invalid locale tags", () => {
  assert.deepEqual(
    getValidLocaleBaseNames(["ko-KR", "invalid locale", "en_us", "ja"]),
    ["ko-KR", "ja"],
  );
});
