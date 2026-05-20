import {
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

export interface LazyMountProps {
  children: JSX.Element;
  // Render `children` immediately. Used for the first few items above the
  // fold so the visible portion of the screen paints without waiting on
  // IntersectionObserver.
  eager?: boolean;
  // Reserved height for the placeholder. Keeps scroll position stable so
  // the page doesn't jump when a card mounts. Override per-call when the
  // typical content height differs from a default note card.
  placeholderHeight?: string;
  // `rootMargin` for the IntersectionObserver. Default mounts the card
  // before it scrolls into view so the user never sees an empty slot.
  rootMargin?: string;
}

// Wraps children in an IntersectionObserver-driven mount gate. Used to
// stagger PostCard mounts down a timeline so the route-transition click
// handler doesn't synchronously build hundreds of Relay fragment
// subscriptions in one task. Server and initial client render emit the
// same placeholder (or `children` for `eager` rows) so hydration is a
// straight match; `onMount` then arms the observer to swap in `children`
// as rows scroll near the viewport. `eager` is tracked reactively so a
// row whose index drops into the eager band after a refetch (e.g. when
// an edge above it is removed) gets promoted to mounted instead of
// staying behind the placeholder.
export function LazyMount(props: LazyMountProps) {
  const [mounted, setMounted] = createSignal(!!props.eager);
  let placeholder: HTMLDivElement | undefined;
  let observer: IntersectionObserver | undefined;

  const disconnectObserver = () => {
    observer?.disconnect();
    observer = undefined;
  };

  onMount(() => {
    if (mounted()) return;
    if (placeholder == null) return;
    // No IntersectionObserver (very old browsers, headless contexts that
    // strip APIs): mount immediately so content is never permanently
    // hidden behind a placeholder.
    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setMounted(true);
          disconnectObserver();
        }
      },
      { rootMargin: props.rootMargin ?? "150% 0px" },
    );
    observer.observe(placeholder);
  });

  // Reactively promote to mounted when `eager` flips true (e.g. a row
  // that shifted up past the eager threshold during a refetch). `Show`'s
  // mounted=true path is one-way, so once mounted we never go back to
  // the placeholder even if `eager` flips false later.
  createEffect(() => {
    if (props.eager) {
      setMounted(true);
      disconnectObserver();
    }
  });

  onCleanup(disconnectObserver);

  return (
    <Show
      when={mounted()}
      fallback={
        <div
          ref={(el) => (placeholder = el)}
          aria-hidden="true"
          style={{ "min-height": props.placeholderHeight ?? "16rem" }}
        />
      }
    >
      {props.children}
    </Show>
  );
}
