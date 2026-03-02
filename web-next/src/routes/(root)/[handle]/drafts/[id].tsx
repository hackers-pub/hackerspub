import { A, query, type RouteDefinition, useParams } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ArticleComposer } from "~/components/article-composer/index.ts";
import { Title } from "~/components/Title.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { IdQuery } from "./__generated__/IdQuery.graphql.ts";

const EditDraftViewerQuery = graphql`
  query IdQuery {
    viewer {
      id
      username
    }
  }
`;

const loadEditDraftViewerQuery = query(
  () =>
    loadQuery<IdQuery>(
      useRelayEnvironment()(),
      EditDraftViewerQuery,
      {},
    ),
  "loadEditDraftViewerQuery",
);

export const route = {
  preload() {
    void loadEditDraftViewerQuery();
  },
} satisfies RouteDefinition;

export default function EditArticleDraftPage() {
  const { t } = useLingui();
  const params = useParams();
  const data = createPreloadedQuery<IdQuery>(
    EditDraftViewerQuery,
    () => loadEditDraftViewerQuery(),
  );

  return (
    <Show
      when={data()?.viewer?.username === params.handle!.substring(1)}
      fallback={
        <div class="container mx-auto p-6">
          <HttpStatusCode code={403} />
          <Title>{t`Permission Denied`}</Title>
          <h1 class="text-2xl font-bold mb-4">{t`Permission Denied`}</h1>
          <p class="text-muted-foreground mb-4">
            {data()?.viewer
              ? t`You can only edit your own drafts`
              : t`Please sign in to access this page`}
          </p>
          <div class="flex gap-2">
            <Button onClick={() => window.history.back()}>
              {t`Go Back`}
            </Button>
            <Show when={data()?.viewer?.username}>
              {(username) => (
                <A href={`/@${username()}/drafts`}>
                  <Button variant="outline">{t`Go to My Drafts`}</Button>
                </A>
              )}
            </Show>
          </div>
        </div>
      }
    >
      <div class="container mx-auto">
        <Title>{t`Edit Draft`}</Title>
        <ArticleComposer
          draftUuid={params.id}
          viewerId={data()?.viewer?.id}
        />
      </div>
    </Show>
  );
}
