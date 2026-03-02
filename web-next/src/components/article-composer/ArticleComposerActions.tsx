import { Show } from "solid-js";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { useArticleComposer } from "./ArticleComposerContext.tsx";

export function ArticleComposerActions() {
  const { t } = useLingui();
  const ctx = useArticleComposer();

  return (
    <div class="flex gap-3 justify-between">
      {/* Delete button (left side) */}
      <Show when={ctx.draft()?.id}>
        <Button
          type="button"
          variant="destructive"
          onClick={ctx.handleDelete}
          disabled={ctx.isDeleting()}
        >
          {ctx.isDeleting() ? t`Deleting...` : t`Delete Draft`}
        </Button>
      </Show>

      {/* Save/Publish buttons (right side) */}
      <div class="flex gap-3 ml-auto">
        <Button
          type="button"
          variant="outline"
          onClick={ctx.handleSave}
          disabled={ctx.isSaving() || !ctx.isDirty()}
        >
          {ctx.isSaving() ? t`Saving...` : t`Save Draft`}
        </Button>

        <Show
          when={!ctx.isPublishing()}
          fallback={
            <div class="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => ctx.setIsPublishing(false)}
              >
                {t`Cancel`}
              </Button>
              <Button type="submit" disabled={ctx.isPublishingMutation()}>
                {ctx.isPublishingMutation() ? t`Publishing...` : t`Publish Now`}
              </Button>
            </div>
          }
        >
          <Button
            type="button"
            onClick={() => ctx.setIsPublishing(true)}
            disabled={!ctx.draft()?.id}
          >
            {t`Publish Article`}
          </Button>
        </Show>
      </div>
    </div>
  );
}
