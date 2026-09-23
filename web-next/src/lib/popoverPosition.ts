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
  /**
   * CSS transform origin that keeps an entrance visually attached to the
   * anchor even when the popover has been clamped against a viewport edge.
   */
  readonly transformOrigin: string;
}

/**
 * Places a quick-pick bar centered over its anchor while keeping it inside
 * the viewport.  The preferred placement is above the anchor (the bar pops
 * up over the trigger), and it flips below only when the upper edge would
 * collide and the lower side has more room.
 */
export function getViewportQuickBarPosition(
  anchor: PopoverAnchorRect,
  bar: PopoverSize,
  viewport: PopoverSize,
  gap = 6,
  margin = 8,
): PopoverPosition {
  const anchorCenter = (anchor.left + anchor.right) / 2;
  const maxLeft = Math.max(margin, viewport.width - bar.width - margin);
  const left = clamp(anchorCenter - bar.width / 2, margin, maxLeft);
  const spaceAbove = anchor.top - margin;
  const spaceBelow = viewport.height - anchor.bottom - margin;

  let preferredTop: number;
  if (bar.height + gap <= spaceAbove) {
    preferredTop = anchor.top - gap - bar.height;
  } else if (bar.height + gap <= spaceBelow || spaceBelow > spaceAbove) {
    preferredTop = anchor.bottom + gap;
  } else {
    preferredTop = anchor.top - gap - bar.height;
  }

  const maxTop = Math.max(margin, viewport.height - bar.height - margin);
  const placedBelow = preferredTop >= anchor.bottom;
  const originX = clamp(anchorCenter - left, 0, bar.width);
  return {
    left,
    top: clamp(preferredTop, margin, maxTop),
    transformOrigin: `${originX}px ${placedBelow ? "top" : "bottom"}`,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
