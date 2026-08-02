import assert from "node:assert";
import test from "node:test";
import {
  getViewportPopoverPosition,
  getViewportQuickBarPosition,
} from "./popoverPosition.ts";

const viewport = { width: 800, height: 600 };
const popover = { width: 320, height: 120 };

test("getViewportPopoverPosition places the popover below when it fits", () => {
  assert.deepEqual(
    getViewportPopoverPosition(
      { left: 200, top: 200, right: 232, bottom: 232 },
      popover,
      viewport,
    ),
    { left: 200, top: 236 },
  );
});

test("getViewportPopoverPosition flips the popover above a bottom-edge trigger", () => {
  assert.deepEqual(
    getViewportPopoverPosition(
      { left: 200, top: 560, right: 232, bottom: 592 },
      popover,
      viewport,
    ),
    { left: 200, top: 436 },
  );
});

test("getViewportPopoverPosition includes the anchor gap in fit checks", () => {
  assert.deepEqual(
    getViewportPopoverPosition(
      { left: 200, top: 440, right: 232, bottom: 472 },
      popover,
      viewport,
    ),
    { left: 200, top: 316 },
  );
});

test("getViewportPopoverPosition shifts within the viewport when neither side fits", () => {
  assert.deepEqual(
    getViewportPopoverPosition(
      { left: 200, top: 100, right: 232, bottom: 132 },
      { width: 320, height: 500 },
      viewport,
    ),
    { left: 200, top: 92 },
  );
});

const quickBar = { width: 340, height: 44 };

test("getViewportQuickBarPosition centers the bar above the anchor", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 300, top: 300, right: 332, bottom: 332 },
      quickBar,
      viewport,
    ),
    { left: 146, top: 250 },
  );
});

test("getViewportQuickBarPosition flips the bar below a top-edge anchor", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 300, top: 20, right: 332, bottom: 52 },
      quickBar,
      viewport,
    ),
    { left: 146, top: 58 },
  );
});

test("getViewportQuickBarPosition clamps both horizontal viewport edges", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 10, top: 300, right: 42, bottom: 332 },
      quickBar,
      viewport,
    ),
    { left: 8, top: 250 },
  );
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 760, top: 300, right: 792, bottom: 332 },
      quickBar,
      viewport,
    ),
    { left: 452, top: 250 },
  );
});

test("getViewportQuickBarPosition stays above when neither side fits", () => {
  assert.deepEqual(
    getViewportQuickBarPosition(
      { left: 300, top: 400, right: 332, bottom: 432 },
      { width: 340, height: 500 },
      viewport,
    ),
    { left: 146, top: 8 },
  );
});

test("getViewportPopoverPosition clamps both horizontal viewport edges", () => {
  assert.deepEqual(
    getViewportPopoverPosition(
      { left: -20, top: 200, right: 12, bottom: 232 },
      popover,
      viewport,
    ),
    { left: 8, top: 236 },
  );
  assert.deepEqual(
    getViewportPopoverPosition(
      { left: 760, top: 200, right: 792, bottom: 232 },
      popover,
      viewport,
    ),
    { left: 472, top: 236 },
  );
});
