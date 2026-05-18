import { fetchQuery, graphql } from "relay-runtime";
import {
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { useRelayEnvironment } from "solid-relay";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/components/ui/tabs.tsx";
import { TextFieldTextArea } from "~/components/ui/text-field.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { MarkdownEditorRenderMarkdownQuery } from "./__generated__/MarkdownEditorRenderMarkdownQuery.graphql.ts";

const renderMarkdownQuery = graphql`
  query MarkdownEditorRenderMarkdownQuery($content: String!) {
    renderMarkdown(content: $content)
  }
`;

export interface MarkdownEditorProps {
  value: string;
  onInput: (value: string) => void;
  ref?: (el: HTMLTextAreaElement) => void;
  id?: string;
  placeholder?: string;
  /** Tailwind min-height class applied to the textarea and preview pane, e.g. `"min-h-[150px]"`. */
  minHeight?: string;
  disabled?: boolean;
  autofocus?: boolean;
  onPaste?: JSX.EventHandler<HTMLTextAreaElement, ClipboardEvent>;
  onWheel?: JSX.EventHandler<HTMLTextAreaElement, WheelEvent>;
  onKeyDown?: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent>;
  /**
   * Whether to show the Preview tab. Defaults to `true`. Pass `false` for
   * unauthenticated contexts where `renderMarkdown` is unavailable.
   */
  showPreview?: boolean;
  /**
   * Increment this value to reset the editor back to the Write tab and clear
   * the preview cache (e.g. after form submission).
   */
  resetKey?: number;
  /** Extra content rendered inside the Write tab, below the textarea (e.g. autocomplete). */
  writeTabSlot?: JSX.Element;
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  const { t } = useLingui();
  const environment = useRelayEnvironment();

  const [activeTab, setActiveTab] = createSignal("write");
  const [previewHtml, setPreviewHtml] = createSignal("");
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewError, setPreviewError] = createSignal(false);
  let lastRenderedText = "";
  let lastRenderedHtml = "";
  let previewRequestVersion = 0;
  let previewSubscription: { unsubscribe: () => void } | undefined;

  const minHeight = () => props.minHeight ?? "min-h-[80px]";

  onCleanup(() => previewSubscription?.unsubscribe());

  createEffect(
    on(
      () => props.resetKey,
      () => {
        previewSubscription?.unsubscribe();
        previewSubscription = undefined;
        lastRenderedText = "";
        lastRenderedHtml = "";
        setActiveTab("write");
        setPreviewHtml("");
        setPreviewError(false);
        setPreviewLoading(false);
      },
      { defer: true },
    ),
  );

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    previewSubscription?.unsubscribe();
    previewSubscription = undefined;
    if (tab !== "preview") {
      setPreviewLoading(false);
      return;
    }
    const text = props.value.trim();
    if (!text) {
      lastRenderedText = "";
      setPreviewHtml("");
      setPreviewError(false);
      setPreviewLoading(false);
      return;
    }
    if (text === lastRenderedText) {
      setPreviewHtml(lastRenderedHtml);
      setPreviewError(false);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(false);
    const requestVersion = ++previewRequestVersion;
    previewSubscription = fetchQuery<MarkdownEditorRenderMarkdownQuery>(
      environment(),
      renderMarkdownQuery,
      { content: text },
    ).subscribe({
      next(data) {
        if (requestVersion !== previewRequestVersion) return;
        lastRenderedText = text;
        lastRenderedHtml = data.renderMarkdown;
        setPreviewHtml(data.renderMarkdown);
        setPreviewLoading(false);
      },
      error() {
        if (requestVersion !== previewRequestVersion) return;
        setPreviewError(true);
        setPreviewHtml("");
        setPreviewLoading(false);
      },
    });
  };

  const textarea = () => (
    <>
      <TextFieldTextArea
        ref={props.ref}
        id={props.id}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onPaste={props.onPaste}
        onWheel={props.onWheel}
        onKeyDown={props.onKeyDown}
        placeholder={props.placeholder}
        autofocus={props.autofocus}
        disabled={props.disabled}
        class={minHeight()}
      />
      {props.writeTabSlot}
    </>
  );

  if (props.showPreview === false) {
    return <>{textarea()}</>;
  }

  return (
    <Tabs value={activeTab()} onChange={handleTabChange}>
      <TabsList class="h-8 w-full p-0.5 mb-1">
        <TabsTrigger value="write" class="flex-1 text-xs">
          {t`Write`}
        </TabsTrigger>
        <TabsTrigger value="preview" class="flex-1 text-xs">
          {t`Preview`}
        </TabsTrigger>
      </TabsList>
      <TabsContent
        value="write"
        class="mt-0 hidden data-[selected]:block"
        forceMount
      >
        {textarea()}
      </TabsContent>
      <TabsContent value="preview" class="mt-0">
        <Show
          when={!previewLoading()}
          fallback={
            <div
              class={`${minHeight()} flex items-center justify-center text-muted-foreground text-sm rounded-md border border-input`}
            >
              {t`Rendering…`}
            </div>
          }
        >
          <Show
            when={previewHtml()}
            fallback={
              <div
                class={`${minHeight()} flex items-center justify-center text-muted-foreground text-sm rounded-md border border-input`}
              >
                {previewError()
                  ? t`Failed to render preview`
                  : t`Nothing to preview`}
              </div>
            }
          >
            <div
              innerHTML={previewHtml()}
              class={`prose dark:prose-invert prose-sm ${minHeight()} max-w-none rounded-md border border-input px-3 py-2 text-sm`}
            />
          </Show>
        </Show>
      </TabsContent>
    </Tabs>
  );
}
