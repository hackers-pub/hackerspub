import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.ts";

// ~9 lines of plain text (x.com's "Show more" threshold).
const DEFAULT_MAX_LINES = 9;

export interface ExpandableHtmlContentProps {
  innerHTML: string;
  lang?: string;
  /** Classes for the element the HTML is rendered into (e.g. `prose` classes). */
  class?: string;
  /** Forwards the rendered content element, e.g. for link/mention handling. */
  contentRef?: (el: HTMLElement) => void;
  /** Collapsed height, in lines, before a "Show more" toggle appears. */
  maxLines?: number;
}

/**
 * Renders trusted post HTML, collapsing it behind a "Show more" toggle once
 * its rendered height exceeds `maxLines`. The collapse height is applied
 * unconditionally via the CSS `lh` unit (so it always matches this
 * element's actual line height, however that's set, with no pixel value to
 * keep in sync by hand) so there is no flash of full-height content before
 * measurement; a `ResizeObserver` only decides whether the toggle itself
 * (and the fade) should be shown, by comparing the element's rendered
 * height against its full content height.
 */
export function ExpandableHtmlContent(props: ExpandableHtmlContentProps) {
  const { t } = useLingui();
  const [contentEl, setContentEl] = createSignal<HTMLElement>();
  const [expanded, setExpanded] = createSignal(false);
  const [overflowing, setOverflowing] = createSignal(false);
  const maxLines = () => props.maxLines ?? DEFAULT_MAX_LINES;

  createEffect(() => {
    const el = contentEl();
    // Re-measure whenever the HTML changes, e.g. the note gets edited.
    void props.innerHTML;
    if (!el) return;
    // Only measure while collapsed: expanding removes the `max-height`
    // clamp, so `clientHeight` grows to match `scrollHeight` and this
    // would otherwise (wrongly) report no overflow, hiding the "Show
    // less" toggle right after the user opens it.
    const measure = () => {
      if (untrack(expanded)) return;
      setOverflowing(el.scrollHeight > el.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div>
      <div class="relative">
        <div
          ref={(el) => {
            setContentEl(el);
            props.contentRef?.(el);
          }}
          innerHTML={props.innerHTML}
          lang={props.lang}
          class={props.class}
          classList={{ "overflow-hidden": !expanded() }}
          style={expanded() ? undefined : { "max-height": `${maxLines()}lh` }}
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
