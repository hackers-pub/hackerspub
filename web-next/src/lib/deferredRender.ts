import {
  type Accessor,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";

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

export function createChunkedVisibleCount(
  totalCount: Accessor<number>,
  options?: {
    initialCount?: number;
    chunkSize?: number;
  },
): Accessor<number> {
  const initialCount = options?.initialCount ?? 5;
  const chunkSize = options?.chunkSize ?? initialCount;
  const [visibleCount, setVisibleCount] = createSignal(initialCount);

  createEffect(() => {
    const total = totalCount();
    const startingCount = Math.min(
      total,
      Math.max(untrack(visibleCount), initialCount),
    );
    setVisibleCount(startingCount);

    let cancelDeferredRender = () => {};
    const revealNextChunk = () => {
      let shouldContinue = false;
      setVisibleCount((current) => {
        const next = Math.min(current + chunkSize, total);
        shouldContinue = next < total;
        return next;
      });
      if (shouldContinue) {
        cancelDeferredRender = scheduleDeferredRender(revealNextChunk);
      }
    };

    if (startingCount < total) {
      cancelDeferredRender = scheduleDeferredRender(revealNextChunk);
    }
    onCleanup(() => cancelDeferredRender());
  });

  return visibleCount;
}
