import assert from "node:assert";
import test from "node:test";
import { resolvePostNode } from "./node.ts";

test("post node loading preserves failures unrelated to its missing row", async () => {
  for (const error of [
    new Error("database connection lost"),
    new Error("Model postTable(other) not found"),
    new Error("Model actorTable(missing) not found"),
    new TypeError("Model postTable(missing) not found"),
  ]) {
    await assert.rejects(
      resolvePostNode("missing", "postTable", () => Promise.reject(error)),
      (caught) => caught === error,
    );
  }
});

test("post node handling does not change other node types", async () => {
  const error = new Error("Model postTable(missing) not found");
  await assert.rejects(
    resolvePostNode("missing", "actorTable", () => {
      throw error;
    }),
    (caught) => caught === error,
  );
});
