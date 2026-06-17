export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function intersectCropRects(
  a: CropRect,
  b: CropRect,
): CropRect | undefined {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) return undefined;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

export function clampSquareCropRect(
  rect: CropRect,
  bounds: CropRect,
): CropRect | undefined {
  const size = Math.min(
    rect.width,
    rect.height,
    bounds.width,
    bounds.height,
  );
  if (size <= 0) return undefined;
  return {
    x: clamp(rect.x, bounds.x, bounds.x + bounds.width - size),
    y: clamp(rect.y, bounds.y, bounds.y + bounds.height - size),
    width: size,
    height: size,
  };
}

export function getScaleToCoverRect(
  covering: CropRect,
  target: CropRect,
): number {
  if (
    covering.width <= 0 || covering.height <= 0 ||
    target.width <= 0 || target.height <= 0
  ) {
    return 1;
  }
  return Math.max(
    1,
    target.width / covering.width,
    target.height / covering.height,
  );
}

export function getOffsetToCoverRect(
  covering: CropRect,
  target: CropRect,
): { readonly x: number; readonly y: number } {
  let x = 0;
  let y = 0;

  if (covering.x > target.x) {
    x = target.x - covering.x;
  } else if (covering.x + covering.width < target.x + target.width) {
    x = target.x + target.width - (covering.x + covering.width);
  }

  if (covering.y > target.y) {
    y = target.y - covering.y;
  } else if (covering.y + covering.height < target.y + target.height) {
    y = target.y + target.height - (covering.y + covering.height);
  }

  return { x, y };
}

export function cropRectsAlmostEqual(
  a: CropRect,
  b: CropRect,
  epsilon = 0.5,
): boolean {
  return Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
