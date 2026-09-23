import { onCleanup } from "solid-js";

/**
 * Re-runs `update` whenever the viewport geometry under a fixed-position
 * popover may have shifted: on window resizes and on scrolls.  The
 * scroll listener is registered in the capture phase because scroll
 * events from nested scrollable ancestors do not bubble to `window`.
 *
 * Call inside the reactive scope that owns the open state (typically an
 * effect gated on it): the listeners are removed when that scope reruns
 * or disposes.
 */
export function createViewportReposition(update: () => void): void {
  window.addEventListener("resize", update);
  window.addEventListener("scroll", update, true);
  onCleanup(() => {
    window.removeEventListener("resize", update);
    window.removeEventListener("scroll", update, true);
  });
}
