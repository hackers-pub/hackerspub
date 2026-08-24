import assert from "node:assert";
import test from "node:test";
import { getViewportQuickBarPosition } from "./popoverPosition.ts";

const viewport = { width: 800, height: 600 };

const quickBar = { width: 340, height: 44 };

test("getViewportQuickBarPosition centers the bar above the anchor", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 300, top: 300, right: 332, bottom: 332 },
      quickBar,
      viewport,
    ),
    { left: 146, top: 250, transformOrigin: "170px bottom" },
  );
});

test("getViewportQuickBarPosition flips the bar below a top-edge anchor", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 300, top: 20, right: 332, bottom: 52 },
      quickBar,
      viewport,
    ),
    { left: 146, top: 58, transformOrigin: "170px top" },
  );
});

test("getViewportQuickBarPosition clamps both horizontal viewport edges", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 10, top: 300, right: 42, bottom: 332 },
      quickBar,
      viewport,
    ),
    { left: 8, top: 250, transformOrigin: "18px bottom" },
  );
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 760, top: 300, right: 792, bottom: 332 },
      quickBar,
      viewport,
    ),
    { left: 452, top: 250, transformOrigin: "324px bottom" },
  );
});

test("getViewportQuickBarPosition stays above when neither side fits", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 300, top: 400, right: 332, bottom: 432 },
      { width: 340, height: 500 },
      viewport,
    ),
    { left: 146, top: 8, transformOrigin: "170px bottom" },
  );
});

test("getViewportQuickBarPosition anchors a 44px touch row on a narrow viewport", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 16, top: 300, right: 60, bottom: 344 },
      { width: 312, height: 48 },
      { width: 320, height: 600 },
      6,
      4,
    ),
    { left: 4, top: 246, transformOrigin: "34px bottom" },
  );
});
