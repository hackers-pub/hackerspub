import { Show } from "solid-js";
import IconLoader2 from "~icons/lucide/loader-2";
import { MarkdownEditor } from "~/components/ui/markdown-editor.tsx";
import { cn } from "~/lib/utils.ts";
import { useLingui } from "~/lib/i18n/macro.ts";

export interface ComposerEditorPanesProps {
  content: string;
  onContentInput: (value: string) => void;
  contentPlaceholder: string;
  onImageUpload: (file: File) => Promise<{ url: string }>;
  previewHtml: string;
  /** Whether a fresh preview is currently being produced. */
  previewPending: boolean;
  previewError?: boolean;
  /** Shown in the preview pane before any preview HTML exists. */
  previewEmptyLabel: string;
  showPreview: boolean;
  onShowPreviewChange: (next: boolean) => void;
}

/**
 * Stage-1 body shared by the draft composer and the article editor: a slim
 * sub-header (Markdown help + a mobile Write/Preview toggle) above the editor
 * and preview panes. On desktop both panes sit side by side; on mobile only one
 * shows at a time, switched via CSS so the editor is never unmounted (CodeMirror
 * state and undo history are preserved).
 */
export function ComposerEditorPanes(props: ComposerEditorPanesProps) {
  const { t } = useLingui();
  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 sm:px-6">
        <a
          href="/markdown"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
        >
          <svg
            fill="currentColor"
            height="128"
            viewBox="0 0 208 128"
            width="208"
            xmlns="http://www.w3.org/2000/svg"
            class="size-4"
            stroke="currentColor"
          >
            <g>
              <path
                clip-rule="evenodd"
                d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15z"
                fill-rule="evenodd"
              />
              <path d="m30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z" />
            </g>
          </svg>
          {t`Markdown supported`}
        </a>

        {/* Mobile-only Write/Preview toggle; desktop shows both panes. */}
        <div class="inline-flex h-9 items-center gap-0.5 rounded-md bg-muted p-1 md:hidden">
          <SegmentButton
            active={!props.showPreview}
            onClick={() => props.onShowPreviewChange(false)}
          >
            {t`Write`}
          </SegmentButton>
          <SegmentButton
            active={props.showPreview}
            onClick={() => props.onShowPreviewChange(true)}
          >
            {t`Preview`}
          </SegmentButton>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col md:flex-row">
        <div
          class="min-h-0 flex-1 flex-col md:flex md:w-1/2 md:border-r"
          classList={{ hidden: props.showPreview, flex: !props.showPreview }}
        >
          <MarkdownEditor
            value={props.content}
            onInput={props.onContentInput}
            placeholder={props.contentPlaceholder}
            ariaLabel={t`Content`}
            showToolbar
            fillHeight
            class="min-h-0 flex-1 rounded-none border-0 focus-within:ring-0 focus-within:ring-offset-0"
            onImageUpload={props.onImageUpload}
          />
        </div>

        <div
          class="min-h-0 flex-1 overflow-y-auto md:block md:w-1/2"
          classList={{ hidden: !props.showPreview }}
        >
          <Show
            when={props.previewHtml}
            fallback={
              <div class="flex h-full items-center justify-center gap-2 px-4 py-3 text-center text-sm text-muted-foreground">
                <Show
                  when={props.previewPending}
                  fallback={
                    <span>
                      {props.previewError
                        ? t`Failed to render preview`
                        : props.previewEmptyLabel}
                    </span>
                  }
                >
                  <IconLoader2 class="size-4 animate-spin" aria-hidden="true" />
                  {t`Rendering…`}
                </Show>
              </div>
            }
          >
            <div class="relative">
              <div
                class="prose dark:prose-invert max-w-none px-4 py-3 sm:px-6"
                innerHTML={props.previewHtml}
              />
              <Show when={props.previewPending}>
                <span class="absolute right-3 top-3 rounded-md border bg-background/80 px-2 py-0.5 text-xs text-muted-foreground backdrop-blur">
                  {t`Updating…`}
                </span>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}

function SegmentButton(props: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      class={cn(
        "inline-flex h-7 items-center rounded-sm px-3 text-xs font-medium transition-colors",
        props.active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}
