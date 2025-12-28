import {
  A,
  query,
  type RouteDefinition,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ArticleComposer } from "~/components/ArticleComposer.tsx";
import { Title } from "~/components/Title.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { newConnectionsQuery } from "./__generated__/newConnectionsQuery.graphql.ts";

const NewDraftConnectionsQuery = graphql`
  query newConnectionsQuery {
    viewer {
      id
      username
    }
  }
`;

const loadNewDraftConnectionsQuery = query(
  () =>
    loadQuery<newConnectionsQuery>(
      useRelayEnvironment()(),
      NewDraftConnectionsQuery,
      {},
    ),
  "loadNewDraftConnectionsQuery",
);

export const route = {
  preload() {
    void loadNewDraftConnectionsQuery();
  },
} satisfies RouteDefinition;

export default function NewArticleDraftPage() {
  const { t } = useLingui();
  const params = useParams();
  const navigate = useNavigate();
  const [draftId, setDraftId] = createSignal<string | undefined>(undefined);

  const connectionsData = createPreloadedQuery<newConnectionsQuery>(
    NewDraftConnectionsQuery,
    () => loadNewDraftConnectionsQuery(),
  );

  const handleSaved = (savedDraftId: string, savedDraftUuid: string) => {
    const newUrl = `/${params.handle}/drafts/${savedDraftUuid}`;
    navigate(newUrl, { replace: true });

    setDraftId(savedDraftId);
  };

  return (
    <Show
      when={connectionsData()?.viewer?.username === params.handle!.substring(1)}
      fallback={
        <div class="container mx-auto p-6">
          <HttpStatusCode code={403} />
          <Title>{t`Permission Denied`}</Title>
          <h1 class="text-2xl font-bold mb-4">{t`Permission Denied`}</h1>
          <p class="text-muted-foreground mb-4">
            {connectionsData()?.viewer
              ? t`You can only create drafts for your own account`
              : t`Please sign in to access this page`}
          </p>
          <div class="flex gap-2">
            <Button onClick={() => window.history.back()}>
              {t`Go Back`}
            </Button>
            <Show when={connectionsData()?.viewer?.username}>
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
        <Title>{draftId() ? t`Edit Draft` : t`New Article`}</Title>
        <ArticleComposer
          onSaved={handleSaved}
          viewerId={connectionsData()?.viewer?.id}
        />
      </div>
    </Show>
  );
}
