import IconLoader2 from "~icons/lucide/loader-2";
import { Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { uploadImage } from "~/lib/uploadImage.ts";
import { useArticleComposer } from "./ArticleComposerContext.tsx";
import { ComposerActionBar } from "./shared/ComposerActionBar.tsx";
import { ComposerEditorPanes } from "./shared/ComposerEditorPanes.tsx";
import { ComposerTitleField } from "./shared/ComposerTitleField.tsx";

export function ArticleComposerWriteStep() {
  const { t } = useLingui();
  const ctx = useArticleComposer();
  const navigate = useNavigate();

  const handleImageUpload = async (file: File): Promise<{ url: string }> => {
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

  const handleShowPreviewChange = (next: boolean) => {
    ctx.setShowPreview(next);
    if (
      next && ctx.content().trim() && (ctx.isDirty() || !ctx.previewHtml())
    ) {
      ctx.handleSave(undefined, true);
    }
  };

  return (
    <>
      <ComposerTitleField
        value={ctx.title()}
        onInput={ctx.setTitle}
        placeholder={t`Title`}
      />

      <ComposerEditorPanes
        content={ctx.content()}
        onContentInput={ctx.setContent}
        contentPlaceholder={t`Write your article here. You can use Markdown. Your article will be automatically saved as a draft while you're writing.`}
        onImageUpload={handleImageUpload}
        previewHtml={ctx.previewHtml()}
        previewPending={ctx.isSaving()}
        previewEmptyLabel={t`Start writing to see a preview.`}
        showPreview={ctx.showPreview()}
        onShowPreviewChange={handleShowPreviewChange}
      />

      <ComposerActionBar
        start={
          <Button
            type="button"
            variant="ghost"
            onClick={() => navigate("..")}
          >
            {t`Back`}
          </Button>
        }
        end={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={ctx.handleSave}
              disabled={ctx.isSaving() || !ctx.isDirty()}
            >
              <Show when={ctx.isSaving()}>
                <IconLoader2 class="size-4 animate-spin" aria-hidden="true" />
              </Show>
              {ctx.isSaving() ? t`Saving…` : t`Save draft`}
            </Button>
            <Button
              type="button"
              onClick={ctx.goToPublishSettings}
              disabled={!ctx.draft()?.id}
            >
              {t`Publish`}
            </Button>
          </>
        }
      />
    </>
  );
}
