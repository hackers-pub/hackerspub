import { Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  type ArticleComposerProps,
  ArticleComposerProvider,
  useArticleComposer,
} from "./ArticleComposerContext.tsx";
import { ArticleComposerForm } from "./ArticleComposerForm.tsx";
import { ArticleComposerActions } from "./ArticleComposerActions.tsx";
import { ArticleComposerPublishFields } from "./ArticleComposerPublishFields.tsx";

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
        <div class="max-w-4xl mx-auto p-6 text-center text-muted-foreground">
          {t`Loading draft...`}
        </div>
      }
    >
      <Show
        when={!ctx.draftUuid || ctx.draft()}
        fallback={
          <div class="max-w-4xl mx-auto p-6 text-center text-muted-foreground">
            {t`Draft not found`}
          </div>
        }
      >
        <div
          class={`mx-auto p-6 ${ctx.showPreview() ? "max-w-7xl" : "max-w-4xl"}`}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (ctx.isPublishing()) {
                ctx.handlePublish(e);
              } else {
                ctx.handleSave(e);
              }
            }}
            class="grid gap-6"
          >
            <ArticleComposerForm />
            <ArticleComposerPublishFields />
            <ArticleComposerActions />
          </form>
        </div>
      </Show>
    </Show>
  );
}
