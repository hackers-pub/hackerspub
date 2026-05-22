import { Show } from "solid-js";
import IconLoader2 from "~icons/lucide/loader-2";
import { Label } from "~/components/ui/label.tsx";
import { MarkdownEditor } from "~/components/ui/markdown-editor.tsx";
import { TagInput } from "~/components/TagInput.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/components/ui/tabs.tsx";
import {
  TextField,
  TextFieldDescription,
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
          class="text-lg font-bold sm:text-2xl"
        />
        <TextFieldDescription class="leading-6">
          {t`The title will appear at the top of your article and in link previews.`}
        </TextFieldDescription>
      </TextField>

      {/* Content */}
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <Label>{t`Content`}</Label>
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
        <Tabs
          value={ctx.showPreview() ? "preview" : "write"}
          onChange={(v) => {
            const toPreview = v === "preview";
            ctx.setShowPreview(toPreview);
            if (
              toPreview && ctx.content().trim() &&
              (ctx.isDirty() || !ctx.previewHtml())
            ) {
              ctx.handleSave(undefined, true);
            }
          }}
        >
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
            <MarkdownEditor
              value={ctx.content()}
              onInput={ctx.setContent}
              placeholder={t`Write your article here. You can use Markdown. Your article will be automatically saved as a draft while you're writing.`}
              showToolbar
              minHeight="400px"
              onImageUpload={handleImageUpload}
            />
          </TabsContent>
          <TabsContent value="preview" class="mt-0">
            <Show
              when={!ctx.isSaving()}
              fallback={
                <div class="min-h-[400px] flex items-center justify-center gap-2 text-sm text-muted-foreground rounded-md border border-input">
                  <IconLoader2 class="size-4 animate-spin" aria-hidden="true" />
                  {t`Rendering…`}
                </div>
              }
            >
              <Show
                when={ctx.previewHtml()}
                fallback={
                  <div class="min-h-[400px] flex items-center justify-center text-sm text-muted-foreground rounded-md border border-input">
                    {t`Save draft to see preview`}
                  </div>
                }
              >
                <div
                  class="prose dark:prose-invert max-w-none min-h-[400px] rounded-md border border-input px-3 py-2"
                  innerHTML={ctx.previewHtml()}
                />
              </Show>
            </Show>
          </TabsContent>
        </Tabs>
      </div>

      {/* Tags */}
      <div class="flex flex-col gap-1.5">
        <Label>{t`Tags`}</Label>
        <TagInput
          value={ctx.tags()}
          onChange={ctx.setTags}
          placeholder={t`Type tags separated by spaces`}
        />
        <p class="text-sm text-muted-foreground leading-6">
          {t`Separate tags with spaces. Tags help readers discover your article.`}
        </p>
      </div>
    </>
  );
}
