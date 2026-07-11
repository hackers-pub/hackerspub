import assert from "node:assert";
import test from "node:test";
import { toRoutablePath } from "./routablePath.ts";

test("toRoutablePath() converts absolute local redirect URLs", () => {
  assert.equal(
    toRoutablePath("https://hackers.pub/@fedify/2026/article?lang=ja#top"),
    "/@fedify/2026/article?lang=ja#top",
  );
});

test("toRoutablePath() preserves relative paths", () => {
  assert.equal(toRoutablePath("/@fedify"), "/@fedify");
});
