import assert from "node:assert";
import test from "node:test";

import { diffLines, hasLineChanges } from "./lineDiff.ts";

test("diffLines keeps unchanged paragraphs aligned", () => {
  const entries = diffLines(
    "First paragraph.\n\nSecond paragraph.",
    "First paragraph.\n\nRewritten paragraph.",
  );
  assert.deepEqual(entries, [
    { kind: "unchanged", text: "First paragraph." },
    { kind: "unchanged", text: "" },
    { kind: "removed", text: "Second paragraph." },
    { kind: "added", text: "Rewritten paragraph." },
  ]);
  assert.equal(hasLineChanges(entries), true);
});

test("diffLines reports an identical text as unchanged", () => {
  const entries = diffLines(
    "Same line.\nAnother line.",
    "Same line.\nAnother line.",
  );
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["unchanged", "unchanged"],
  );
  assert.equal(hasLineChanges(entries), false);
});

test("diffLines handles insertion and deletion at the edges", () => {
  assert.deepEqual(diffLines("", "Added."), [
    { kind: "added", text: "Added." },
  ]);
  assert.deepEqual(diffLines("Removed.", ""), [
    { kind: "removed", text: "Removed." },
  ]);
  assert.deepEqual(diffLines("b", "a\nb\nc"), [
    { kind: "added", text: "a" },
    { kind: "unchanged", text: "b" },
    { kind: "added", text: "c" },
  ]);
});

test("diffLines normalizes CRLF so a line-ending change is not a diff", () => {
  const entries = diffLines("a\r\nb", "a\nb");
  assert.equal(hasLineChanges(entries), false);
});
