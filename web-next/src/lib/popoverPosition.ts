export interface PopoverAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PopoverSize {
  readonly width: number;
  readonly height: number;
}

export interface PopoverPosition {
  readonly left: number;
  readonly top: number;
}

/**
 * Places a popover next to its anchor while keeping it inside the viewport.
 * The preferred placement is below the anchor, but it flips above when the
 * lower edge would collide and the upper side has enough room.
 */
export function getViewportPopoverPosition(
  anchor: PopoverAnchorRect,
  popover: PopoverSize,
  viewport: PopoverSize,
  gap = 4,
  margin = 8,
): PopoverPosition {
  const maxLeft = Math.max(margin, viewport.width - popover.width - margin);
  const left = clamp(anchor.left, margin, maxLeft);
  const spaceAbove = anchor.top - margin;
  const spaceBelow = viewport.height - anchor.bottom - margin;

  let preferredTop: number;
  if (popover.height + gap <= spaceBelow) {
    preferredTop = anchor.bottom + gap;
  } else if (popover.height + gap <= spaceAbove || spaceAbove > spaceBelow) {
    preferredTop = anchor.top - gap - popover.height;
  } else {
    preferredTop = anchor.bottom + gap;
  }

  const maxTop = Math.max(margin, viewport.height - popover.height - margin);
  return { left, top: clamp(preferredTop, margin, maxTop) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
