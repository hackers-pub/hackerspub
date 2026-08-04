import { onCleanup } from "solid-js";

/**
 * Dismisses a floating element when a pointer goes down outside `root`.
 * Registered on `document` in the capture phase so an inner
 * `stopPropagation` cannot keep the element open.  Pointer-down (rather
 * than click or focus) is what makes outside taps work on iOS Safari,
 * which never focuses tapped buttons.
 *
 * Kobalte's `createInteractOutside` is deliberately not used here: for
 * touch pointers it defers dismissal to the synthesized `click`, while
 * dismissing on the raw `pointerdown` is the point of this helper.
 *
 * Call inside the reactive scope that owns the open state (typically an
 * effect gated on it): the listener is removed when that scope reruns
 * or disposes.
 */
export function createOutsideDismiss(
  root: () => Node | undefined,
  onDismiss: () => void,
): void {
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Node && root()?.contains(target)) return;
    onDismiss();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
  });
}
