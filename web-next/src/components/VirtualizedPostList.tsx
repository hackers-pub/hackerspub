import { Key } from "@solid-primitives/keyed";
import {
  createWindowVirtualizer,
  defaultRangeExtractor,
  measureElement as defaultMeasureElement,
  type Range,
} from "@tanstack/solid-virtual";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import {
  getInitialVirtualListItemCount,
  measureVirtualListItem,
  measureVirtualListItemAfterMount,
  shouldResetVirtualListMeasurements,
  virtualListFooterVisible,
  virtualListGapAfter,
  virtualListGapBefore,
  virtualListRowHasBottomBorder,
} from "~/lib/virtualList.ts";

const ESTIMATED_POST_HEIGHT = 256;
const POST_OVERSCAN = 3;

export interface VirtualizedPostListProps<T> {
  items: readonly T[];
  getItemKey: (item: T) => string;
  initialItemCount: number;
  renderItem: (item: T) => JSX.Element;
  hasFooter?: boolean;
  renderFooter?: () => JSX.Element;
}

export function VirtualizedPostList<T>(props: VirtualizedPostListProps<T>) {
  const [active, setActive] = createSignal(false);
  const [focusedKey, setFocusedKey] = createSignal<string>();
  const [scrollMargin, setScrollMargin] = createSignal(0);
  let listElement: HTMLDivElement | undefined;
  const initialElements = new Map<number, HTMLDivElement>();

  const initialItemCount = createMemo(() =>
    getInitialVirtualListItemCount(props.items.length, props.initialItemCount),
  );
  const initialItems = createMemo(() =>
    Array.from({ length: initialItemCount() }, (_, index) => ({ index })),
  );
  const getItemKey = (index: number): string | number => {
    const item = props.items[index];
    return item == null ? index : props.getItemKey(item);
  };
  const virtualizer = createWindowVirtualizer<HTMLDivElement>({
    get count() {
      return props.items.length;
    },
    estimateSize: () => ESTIMATED_POST_HEIGHT,
    // Row refs run before Solid inserts the element, so the synchronous
    // measurement from the ref sees a detached node and would read 0. A 0px
    // size is written to the virtualizer immediately, which re-runs the range
    // calculation while Solid is still iterating the virtual items store and
    // crashes. Keep the cached/estimated size instead; the ResizeObserver
    // measures the real height once the row is in the document.
    measureElement: (element, entry, instance) =>
      element.isConnected
        ? defaultMeasureElement(element, entry, instance)
        : (instance.itemSizeCache.get(
            getItemKey(instance.indexFromElement(element)),
          ) ?? ESTIMATED_POST_HEIGHT),
    getItemKey,
    overscan: POST_OVERSCAN,
    get scrollMargin() {
      return scrollMargin();
    },
    get rangeExtractor() {
      const key = focusedKey();
      const focusedIndex =
        key == null
          ? -1
          : props.items.findIndex((item) => props.getItemKey(item) === key);
      return (range: Range) => {
        const indexes = defaultRangeExtractor(range);
        if (focusedIndex < 0 || indexes.includes(focusedIndex)) return indexes;
        return [...indexes, focusedIndex].sort((a, b) => a - b);
      };
    },
  });
  const virtualItems = () => virtualizer.getVirtualItems();

  const footerVisible = () =>
    virtualListFooterVisible(
      !!props.hasFooter,
      active(),
      initialItemCount(),
      props.items.length,
    );
  const rowHasBottomBorder = (index: number) =>
    virtualListRowHasBottomBorder(
      index,
      props.items.length,
      initialItemCount(),
      active(),
      !!props.hasFooter,
    );

  const updateScrollMargin = () => {
    if (listElement == null) return;
    setScrollMargin(listElement.getBoundingClientRect().top + window.scrollY);
  };

  const activate = () => {
    updateScrollMargin();
    const previousScrollAdjustment =
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange;
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    try {
      for (const [index, element] of initialElements) {
        if (!element.isConnected) continue;
        virtualizer.resizeItem(index, element.offsetHeight);
      }
    } finally {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange =
        previousScrollAdjustment;
    }
    initialElements.clear();
    setActive(true);
  };

  onMount(() => {
    // On client-side navigation the list mounts while the route is still
    // inside a pending router transition, so nothing here is in the document
    // yet and every layout read (scroll margin, initial row heights) would be
    // 0. Wait for the element to be connected and for one complete layout
    // frame before seeding the virtualizer.
    let activationFrame: number | undefined;
    let connectedFrames = 0;
    const activateWhenConnected = () => {
      if (listElement?.isConnected && ++connectedFrames > 1) {
        activationFrame = undefined;
        activate();
        return;
      }
      if (!listElement?.isConnected) connectedFrames = 0;
      activationFrame = window.requestAnimationFrame(activateWhenConnected);
    };
    activateWhenConnected();

    let frame: number | undefined;
    const scheduleScrollMarginUpdate = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        updateScrollMargin();
      });
    };
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(scheduleScrollMarginUpdate);
    // Do not ResizeObserve the list, its parent, or the document body. Row
    // measurements change all three sizes, which feeds back into another
    // observer delivery and can defer layout updates. Direct sibling changes
    // cover the new-post banner/footer cases that can move the list itself.
    if (listElement?.parentElement != null) {
      mutationObserver?.observe(listElement.parentElement, { childList: true });
    }
    window.addEventListener("resize", scheduleScrollMarginUpdate);
    window.addEventListener("scroll", scheduleScrollMarginUpdate, {
      passive: true,
    });
    document.addEventListener("load", scheduleScrollMarginUpdate, true);

    onCleanup(() => {
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleScrollMarginUpdate);
      window.removeEventListener("scroll", scheduleScrollMarginUpdate);
      document.removeEventListener("load", scheduleScrollMarginUpdate, true);
      if (frame != null) window.cancelAnimationFrame(frame);
      if (activationFrame != null) {
        window.cancelAnimationFrame(activationFrame);
      }
    });
  });

  let previousKeys: readonly string[] | undefined;
  createEffect(() => {
    const currentKeys = props.items.map(props.getItemKey);
    const previous = previousKeys;
    previousKeys = currentKeys;
    if (
      previous != null &&
      active() &&
      shouldResetVirtualListMeasurements(previous, currentKeys)
    ) {
      untrack(() => virtualizer.measure());
    }

    const focused = focusedKey();
    if (focused != null && !currentKeys.includes(focused)) {
      setFocusedKey(undefined);
    }
  });

  const onRowFocusOut = (
    event: FocusEvent & { currentTarget: HTMLDivElement },
  ) => {
    const row = event.currentTarget;
    const initialFocusedKey = focusedKey();
    queueMicrotask(() => {
      if (!row.contains(document.activeElement)) {
        setFocusedKey((current) =>
          current === initialFocusedKey ? undefined : current,
        );
      }
    });
  };

  const measureVirtualItem = (
    element: HTMLDivElement,
    index: number,
    expectedKey: string,
  ): (() => void) => {
    // Solid runs refs before applying reactive attributes, while TanStack
    // Virtual reads data-index synchronously when measureElement() is called.
    measureVirtualListItem(element, index, virtualizer.measureElement);

    const item = props.items[index];
    if (item == null) return () => undefined;
    // Row refs normally run while the element is detached. Registering a
    // detached row with TanStack's ResizeObserver can make its first callback
    // discard the row before Solid inserts it. Register and measure once after
    // insertion so later content changes remain observed and variable-height
    // cards cannot overlap.
    return measureVirtualListItemAfterMount(
      element,
      expectedKey,
      (currentIndex) =>
        untrack(() => {
          const currentItem = props.items[currentIndex];
          return currentItem == null
            ? undefined
            : props.getItemKey(currentItem);
        }),
      virtualizer.measureElement,
    );
  };

  return (
    <>
      <div
        ref={(element) => (listElement = element)}
        style={{
          "overflow-anchor": active() ? "none" : undefined,
        }}
      >
        <Show
          when={active()}
          fallback={
            <For each={initialItems()}>
              {({ index }) => {
                const item = () => props.items[index];
                return (
                  <Show when={item()}>
                    {(item) => (
                      <div
                        ref={(element) => initialElements.set(index, element)}
                        data-virtual-post-index={index}
                        class="w-full [&>article]:border-b-0"
                        classList={{ "border-b": rowHasBottomBorder(index) }}
                      >
                        {props.renderItem(item())}
                      </div>
                    )}
                  </Show>
                );
              }}
            </For>
          }
        >
          {/* The Solid adapter reconciles virtual items by index. Key the DOM
              by the post so prepends preserve its ResizeObserver, and keep
              mounted rows in normal flow so height changes move later rows
              immediately. Spacers represent only the unmounted ranges. */}
          <Key each={virtualItems()} by={(virtualItem) => virtualItem.key}>
            {(virtualItem, position) => {
              let cancelMeasurement: (() => void) | undefined;
              onCleanup(() => cancelMeasurement?.());
              const item = () => props.items[virtualItem().index];
              const key = () => {
                const value = item();
                return value == null ? undefined : props.getItemKey(value);
              };
              return (
                <>
                  <div
                    aria-hidden="true"
                    style={{
                      height: `${virtualListGapBefore(
                        virtualItems(),
                        position(),
                        scrollMargin(),
                      )}px`,
                    }}
                  />
                  <Show when={item()}>
                    {(item) => (
                      <div
                        data-index={virtualItem().index}
                        data-virtual-post-index={virtualItem().index}
                        ref={(element) => {
                          cancelMeasurement?.();
                          const itemKey = key();
                          if (itemKey == null) return;
                          cancelMeasurement = measureVirtualItem(
                            element,
                            virtualItem().index,
                            itemKey,
                          );
                        }}
                        onFocusIn={() => setFocusedKey(key())}
                        onFocusOut={onRowFocusOut}
                        class="w-full [&>article]:border-b-0"
                        classList={{
                          "border-b": rowHasBottomBorder(virtualItem().index),
                        }}
                      >
                        {props.renderItem(item())}
                      </div>
                    )}
                  </Show>
                </>
              );
            }}
          </Key>
          <div
            aria-hidden="true"
            style={{
              height: `${virtualListGapAfter(
                virtualItems(),
                virtualizer.getTotalSize(),
                scrollMargin(),
              )}px`,
            }}
          />
        </Show>
      </div>
      <Show when={footerVisible()}>{props.renderFooter?.()}</Show>
    </>
  );
}
