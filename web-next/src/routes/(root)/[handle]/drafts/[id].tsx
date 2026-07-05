import { A, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { ArticleComposer } from "~/components/article-composer/index.ts";
import { Title } from "~/components/Title.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { IdQuery } from "./__generated__/IdQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

const EditDraftViewerQuery = graphql`
  query IdQuery {
    viewer {
      id
      username
    }
  }
`;

const loadEditDraftViewerQuery = routePreloadedQuery(
  () =>
    loadQuery<IdQuery>(
      useRelayEnvironment()(),
      EditDraftViewerQuery,
      {},
    ),
  "loadEditDraftViewerQuery",
);

export default function EditArticleDraftPage() {
  const { t } = useLingui();
  const params = useParams();
  const data = createStablePreloadedQuery<IdQuery>(
    EditDraftViewerQuery,
    () => loadEditDraftViewerQuery(),
  );

  return (
    <Show
      when={data()?.viewer?.username ===
        decodeRouteParam(params.handle!).substring(1)}
      fallback={
        <WideContainer class="p-6">
          <HttpStatusCode code={403} />
          <Title>{t`Permission denied`}</Title>
          <h1 class="text-2xl font-bold mb-4">{t`Permission denied`}</h1>
          <p class="text-muted-foreground mb-4">
            {data()?.viewer
              ? t`You can only edit your own drafts`
              : t`Please sign in to access this page`}
          </p>
          <div class="flex gap-2">
            <Button onClick={() => window.history.back()}>
              {t`Go back`}
            </Button>
            <Show keyed when={data()?.viewer?.username}>
              {(username) => (
                <A href={`/@${username}/drafts`}>
                  <Button variant="outline">{t`Go to my drafts`}</Button>
                </A>
              )}
            </Show>
          </div>
        </WideContainer>
      }
    >
      <div class="flex h-[100dvh] flex-col overflow-hidden">
        <Title>{t`Edit draft`}</Title>
        <ArticleComposer
          draftUuid={params.id}
          viewerId={data()?.viewer?.id}
        />
      </div>
    </Show>
  );
}
