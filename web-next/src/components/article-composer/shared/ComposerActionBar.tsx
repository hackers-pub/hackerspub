import type { JSX } from "solid-js";

export interface ComposerActionBarProps {
  /** Left-aligned controls (e.g. Back, Delete). */
  start?: JSX.Element;
  /** Right-aligned controls (e.g. Save, Publish). */
  end?: JSX.Element;
}

/**
 * The sticky bottom bar shared by every composer stage: a single hairline
 * `border-t`, no shadow, with a left group and a right group.
 */
export function ComposerActionBar(props: ComposerActionBarProps) {
  return (
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-background px-4 py-3 sm:px-6">
      <div class="flex items-center gap-3">{props.start}</div>
      <div class="ml-auto flex flex-wrap items-center justify-end gap-3">
        {props.end}
      </div>
    </div>
  );
}
