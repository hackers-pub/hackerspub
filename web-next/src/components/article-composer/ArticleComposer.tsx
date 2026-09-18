import { Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import {
  type ArticleComposerProps,
  ArticleComposerProvider,
  useArticleComposer,
} from "./ArticleComposerContext.tsx";
import { ArticleComposerWriteStep } from "./ArticleComposerWriteStep.tsx";
import { ArticleComposerPublishStep } from "./ArticleComposerPublishStep.tsx";

export { type ArticleComposerProps };

export function ArticleComposer(props: ArticleComposerProps) {
  return (
    <ArticleComposerProvider {...props}>
      <ArticleComposerInner />
    </ArticleComposerProvider>
  );
}

function ArticleComposerInner() {
  const { t } = useLingui();
  const ctx = useArticleComposer();

  return (
    <Show
      when={ctx.draftDataLoaded()}
      fallback={
        <div class="grid flex-1 place-items-center p-6 text-center text-muted-foreground">
          {t`Loading draft…`}
        </div>
      }
    >
      <Show
        when={!ctx.existingDraft || ctx.draft()}
        fallback={
          <div class="grid flex-1 place-items-center p-6 text-center text-muted-foreground">
            {t`This draft is no longer available or you no longer have access.`}
          </div>
        }
      >
        <form
          onSubmit={(e) => e.preventDefault()}
          class="flex min-h-0 flex-1 flex-col"
        >
          <Show when={ctx.saveStatus() === "unavailable"}>
            <div class="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-6">
              {t`This draft is no longer available or you no longer have access. Your local edits are preserved but cannot be saved.`}
            </div>
          </Show>
          <Show
            when={!ctx.isPublishing()}
            fallback={<ArticleComposerPublishStep />}
          >
            <ArticleComposerWriteStep />
          </Show>
        </form>
        <SaveConflictDialog />
      </Show>
    </Show>
  );
}

function SaveConflictDialog() {
  const { t } = useLingui();
  const ctx = useArticleComposer();

  return (
    <AlertDialog open={ctx.saveStatus() === "conflict"}>
      <AlertDialogContent class="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t`This draft was changed by someone else`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t`Another member saved a newer revision while you were editing. Your changes are still here. Choose whether to overwrite the server version with your edits or discard your edits and load the latest version.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose onClick={ctx.discardAndReload}>
            {t`Discard my changes and load latest`}
          </AlertDialogClose>
          <AlertDialogAction onClick={ctx.overwriteWithLocal}>
            {t`Overwrite with my changes`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
