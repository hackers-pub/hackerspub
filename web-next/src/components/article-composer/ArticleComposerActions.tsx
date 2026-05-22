import { Show } from "solid-js";
import IconLoader2 from "~icons/lucide/loader-2";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { useArticleComposer } from "./ArticleComposerContext.tsx";

export function ArticleComposerActions() {
  const { t } = useLingui();
  const ctx = useArticleComposer();

  return (
    <div class="flex flex-wrap justify-between gap-3">
      {/* Delete button (left side) */}
      <Show when={ctx.draft()?.id}>
        <Button
          type="button"
          variant="destructive"
          onClick={ctx.handleDelete}
          disabled={ctx.isDeleting()}
        >
          {ctx.isDeleting() ? t`Deleting…` : t`Delete draft`}
        </Button>
      </Show>

      {/* Save/Publish buttons (right side) */}
      <div class="ml-auto flex flex-wrap justify-end gap-3">
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
                {ctx.isPublishingMutation() ? t`Publishing…` : t`Publish now`}
              </Button>
            </div>
          }
        >
          <Button
            type="button"
            onClick={() => ctx.setIsPublishing(true)}
            disabled={!ctx.draft()?.id}
          >
            {t`Publish article`}
          </Button>
        </Show>
      </div>
    </div>
  );
}
