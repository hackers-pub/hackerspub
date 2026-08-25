import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.ts";

// ~9 lines of plain text (x.com's "Show more" threshold), at the base
// `.prose` line height of 28px (16px font-size * 1.75 line-height).
const DEFAULT_MAX_HEIGHT_PX = 9 * 28;

export interface ExpandableHtmlContentProps {
  innerHTML: string;
  lang?: string;
  /** Classes for the element the HTML is rendered into (e.g. `prose` classes). */
  class?: string;
  /** Forwards the rendered content element, e.g. for link/mention handling. */
  contentRef?: (el: HTMLElement) => void;
  /** Collapsed height in pixels before a "Show more" toggle appears. */
  maxHeightPx?: number;
}

/**
 * Renders trusted post HTML, collapsing it behind a "Show more" toggle once
 * its rendered height exceeds `maxHeightPx`. The collapse height is applied
 * unconditionally via CSS so there is no flash of full-height content before
 * measurement; a `ResizeObserver` only decides whether the toggle itself
 * (and the fade) should be shown.
 */
export function ExpandableHtmlContent(props: ExpandableHtmlContentProps) {
  const { t } = useLingui();
  const [contentEl, setContentEl] = createSignal<HTMLElement>();
  const [expanded, setExpanded] = createSignal(false);
  const [overflowing, setOverflowing] = createSignal(false);
  const maxHeight = () => props.maxHeightPx ?? DEFAULT_MAX_HEIGHT_PX;

  createEffect(() => {
    const el = contentEl();
    // Re-measure whenever the HTML changes, e.g. the note gets edited.
    void props.innerHTML;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > maxHeight() + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div>
      <div
        class="relative"
        classList={{ "overflow-hidden": !expanded() }}
        style={expanded() ? undefined : { "max-height": `${maxHeight()}px` }}
      >
        <div
          ref={(el) => {
            setContentEl(el);
            props.contentRef?.(el);
          }}
          innerHTML={props.innerHTML}
          lang={props.lang}
          class={props.class}
        />
        <Show when={overflowing() && !expanded()}>
          <div
            aria-hidden="true"
            class="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-background to-transparent"
          />
        </Show>
      </div>
      <Show when={overflowing()}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          class="mt-1 cursor-pointer rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {expanded() ? t`Show less` : t`Show more`}
        </button>
      </Show>
    </div>
  );
}
