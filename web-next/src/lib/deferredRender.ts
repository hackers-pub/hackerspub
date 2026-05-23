import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function scheduleDeferredRender(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback != null) {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 250 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, 16);
  return () => window.clearTimeout(handle);
}

export function createDeferredRender(
  shouldDefer: Accessor<boolean>,
): Accessor<boolean> {
  const [ready, setReady] = createSignal(!shouldDefer());

  createEffect(() => {
    if (!shouldDefer()) {
      setReady(true);
      return;
    }
    if (ready()) return;

    const cancelDeferredRender = scheduleDeferredRender(() => setReady(true));
    onCleanup(cancelDeferredRender);
  });

  return ready;
}
