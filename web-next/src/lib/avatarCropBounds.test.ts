import assert from "node:assert";
import test from "node:test";
import {
  clampSquareCropRect,
  cropRectsAlmostEqual,
  getOffsetToCoverRect,
  getScaleToCoverRect,
  intersectCropRects,
} from "./avatarCropBounds.ts";

test("intersectCropRects returns the visible overlap", () => {
  assert.deepEqual(
    intersectCropRects(
      { x: 0, y: 0, width: 120, height: 80 },
      { x: 50, y: 20, width: 120, height: 80 },
    ),
    { x: 50, y: 20, width: 70, height: 60 },
  );
});

test("intersectCropRects returns undefined when rectangles do not overlap", () => {
  assert.deepEqual(
    intersectCropRects(
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 50, y: 0, width: 50, height: 50 },
    ),
    undefined,
  );
});

test("clampSquareCropRect keeps a square crop inside bounds", () => {
  assert.deepEqual(
    clampSquareCropRect(
      { x: -25, y: 90, width: 140, height: 140 },
      { x: 10, y: 20, width: 100, height: 100 },
    ),
    { x: 10, y: 20, width: 100, height: 100 },
  );
});

test("clampSquareCropRect shrinks to the smaller bound dimension", () => {
  assert.deepEqual(
    clampSquareCropRect(
      { x: 90, y: 30, width: 180, height: 180 },
      { x: 20, y: 10, width: 160, height: 90 },
    ),
    { x: 90, y: 10, width: 90, height: 90 },
  );
});

test("getScaleToCoverRect returns the minimum scale that covers the target", () => {
  assert.deepEqual(
    getScaleToCoverRect(
      { x: 0, y: 0, width: 200, height: 100 },
      { x: 50, y: 20, width: 160, height: 120 },
    ),
    1.2,
  );
});

test("getOffsetToCoverRect moves the covering rect over exposed target edges", () => {
  assert.deepEqual(
    getOffsetToCoverRect(
      { x: 20, y: 15, width: 100, height: 100 },
      { x: 0, y: 0, width: 80, height: 80 },
    ),
    { x: -20, y: -15 },
  );
  assert.deepEqual(
    getOffsetToCoverRect(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 40, y: 30, width: 80, height: 80 },
    ),
    { x: 20, y: 10 },
  );
});

test("cropRectsAlmostEqual tolerates subpixel cropper differences", () => {
  assert.deepEqual(
    cropRectsAlmostEqual(
      { x: 10, y: 20, width: 30, height: 40 },
      { x: 10.25, y: 19.75, width: 30.5, height: 39.6 },
    ),
    true,
  );
});
