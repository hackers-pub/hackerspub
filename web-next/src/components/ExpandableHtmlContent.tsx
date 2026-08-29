import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
} from "solid-js";
import { HtmlContent } from "~/components/HtmlContent.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";

// ~9 lines of plain text (x.com's "Show more" threshold).
const DEFAULT_MAX_LINES = 9;
// Expanding should reveal enough content to justify the extra control.
const DEFAULT_MIN_HIDDEN_LINES = 4;

export interface ExpandableHtmlContentProps {
  html: string;
  lang?: string;
  /** Classes for the element the HTML is rendered into (e.g. `prose` classes). */
  class?: string;
  /** Forwards the rendered content element, e.g. for link/mention handling. */
  contentRef?: (el: HTMLElement) => void;
  /** Height retained when content is collapsed. */
  maxLines?: number;
}

/**
 * Renders trusted post HTML, collapsing it behind a "Show more" toggle only
 * when the hidden portion is large enough to make expanding worthwhile. The
 * collapse height is applied before measurement via the CSS `lh` unit so long
 * content does not flash at full height. After measurement, marginal overflow
 * is unclamped and shown without a toggle.
 */
export function ExpandableHtmlContent(props: ExpandableHtmlContentProps) {
  const { t } = useLingui();
  const contentId = createUniqueId();
  const [contentEl, setContentEl] = createSignal<HTMLElement>();
  const [expanded, setExpanded] = createSignal(false);
  const [collapsible, setCollapsible] = createSignal<boolean>();
  const maxLines = () => props.maxLines ?? DEFAULT_MAX_LINES;
  // Keep the initial server/client render clamped until it can be measured.
  const collapsed = () => collapsible() !== false && !expanded();

  createEffect(() => {
    const initialElement = contentEl();
    // Re-measure whenever the HTML changes, e.g. the note gets edited.
    void props.html;
    if (!initialElement) return;
    const measure = () => {
      const computedStyle = getComputedStyle(initialElement);
      const computedLineHeight = Number.parseFloat(computedStyle.lineHeight);
      const computedFontSize = Number.parseFloat(computedStyle.fontSize);
      const lineHeight = Number.isFinite(computedLineHeight)
        ? computedLineHeight
        : computedFontSize * 1.2;
      const collapseThreshold =
        (maxLines() + DEFAULT_MIN_HIDDEN_LINES) * lineHeight;
      setCollapsible(initialElement.scrollHeight > collapseThreshold);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(initialElement);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div>
      <div class="relative">
        <HtmlContent
          id={contentId}
          ref={(el) => {
            setContentEl(el);
            props.contentRef?.(el);
          }}
          html={props.html}
          lang={props.lang}
          class={props.class}
          classList={{ "overflow-hidden": collapsed() }}
          style={collapsed() ? { "max-height": `${maxLines()}lh` } : undefined}
        />
        <Show when={collapsible() && !expanded()}>
          <div
            aria-hidden="true"
            class="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-background to-transparent"
          />
        </Show>
      </div>
      <Show when={collapsible()}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded()}
          aria-controls={contentId}
          class="mt-1 cursor-pointer rounded-sm text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {expanded() ? t`Show less` : t`Show more`}
        </button>
      </Show>
    </div>
  );
}
