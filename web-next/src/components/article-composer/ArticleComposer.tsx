import { Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.ts";
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
            {t`Draft not found`}
          </div>
        }
      >
        <form
          onSubmit={(e) => e.preventDefault()}
          class="flex min-h-0 flex-1 flex-col"
        >
          <Show
            when={!ctx.isPublishing()}
            fallback={<ArticleComposerPublishStep />}
          >
            <ArticleComposerWriteStep />
          </Show>
        </form>
      </Show>
    </Show>
  );
}
