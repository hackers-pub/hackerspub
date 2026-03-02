import { Show } from "solid-js";
import { MarkdownEditor } from "~/components/ui/markdown-editor.tsx";
import { TagInput } from "~/components/TagInput.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { uploadImage } from "~/lib/uploadImage.ts";
import { useArticleComposer } from "./ArticleComposerContext.tsx";

export function ArticleComposerForm() {
  const { t } = useLingui();
  const ctx = useArticleComposer();

  const handleImageUpload = async (
    file: File,
  ): Promise<{ url: string }> => {
    try {
      const result = await uploadImage(file, ctx.draftUuid);
      return { url: result.url };
    } catch (error) {
      showToast({
        title: t`Error`,
        description: error instanceof Error
          ? error.message
          : t`Failed to upload image`,
        variant: "error",
      });
      throw error;
    }
  };

  return (
    <>
      {/* Title */}
      <TextField>
        <TextFieldLabel>{t`Title`}</TextFieldLabel>
        <TextFieldInput
          value={ctx.title()}
          onInput={(e) => ctx.setTitle(e.currentTarget.value)}
          placeholder={t`Please enter a title for your article.`}
          required
          class="text-2xl font-bold"
        />
      </TextField>

      {/* Content */}
      <div class="flex flex-col gap-1">
        <label class="flex items-center justify-between text-sm font-medium">
          <span>{t`Content`}</span>
          <div class="flex items-center gap-3">
            {/* Preview toggle */}
            <button
              type="button"
              onClick={() => {
                const newShowPreview = !ctx.showPreview();
                ctx.setShowPreview(newShowPreview);
                if (
                  newShowPreview && ctx.content().trim() && !ctx.previewHtml()
                ) {
                  ctx.handleSave();
                }
              }}
              class={`px-3 py-1 text-xs font-medium rounded-md border transition-colors ${
                ctx.showPreview()
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-input hover:bg-muted"
              }`}
            >
              {ctx.showPreview() ? t`Hide Preview` : t`Show Preview`}
            </button>
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
          </div>
        </label>
        <div
          class={`grid gap-4 ${
            ctx.showPreview() ? "md:grid-cols-2" : "grid-cols-1"
          }`}
        >
          {/* Editor (hidden on mobile when preview is shown) */}
          <div class={ctx.showPreview() ? "hidden md:block" : ""}>
            <MarkdownEditor
              value={ctx.content()}
              onInput={ctx.setContent}
              placeholder={t`Write your article here. You can use Markdown. Your article will be automatically saved as a draft while you're writing.`}
              showToolbar
              minHeight="400px"
              onImageUpload={handleImageUpload}
            />
          </div>
          {/* Preview */}
          <Show when={ctx.showPreview()}>
            <div class="w-full rounded-md border border-input bg-background min-h-[400px] p-4 overflow-auto">
              <Show
                when={ctx.previewHtml()}
                fallback={
                  <div class="flex items-center justify-center h-full min-h-[360px] text-muted-foreground">
                    {t`Save draft to see preview`}
                  </div>
                }
              >
                <div
                  class="prose dark:prose-invert max-w-none"
                  innerHTML={ctx.previewHtml()}
                />
              </Show>
            </div>
          </Show>
        </div>
      </div>

      {/* Tags */}
      <div>
        <label class="text-sm font-medium">{t`Tags`}</label>
        <TagInput
          value={ctx.tags()}
          onChange={ctx.setTags}
          placeholder={t`Type tags separated by spaces`}
          class="mt-2"
        />
      </div>
    </>
  );
}
