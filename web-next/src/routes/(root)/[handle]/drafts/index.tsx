import { A, query, type RouteDefinition, useParams } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  createMutation,
  createPaginationFragment,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { Badge } from "~/components/ui/badge.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { showToast } from "~/components/ui/toast.tsx";
import type { draftsQuery } from "./__generated__/draftsQuery.graphql.ts";
import type { draftsDeleteMutation } from "./__generated__/draftsDeleteMutation.graphql.ts";
import type { draftsPaginationFragment$key } from "./__generated__/draftsPaginationFragment.graphql.ts";

const DRAFTS_PAGE_SIZE = 50 as const;

const DraftsQuery = graphql`
  query draftsQuery($first: Int, $after: String) {
    viewer {
      id
      username
      ...draftsPaginationFragment @arguments(first: $first, after: $after)
    }
  }
`;

const DraftsPaginationFragment = graphql`
  fragment draftsPaginationFragment on Account
    @refetchable(queryName: "draftsPaginationRefetchQuery")
    @argumentDefinitions(
      first: { type: "Int", defaultValue: 50 }
      after: { type: "String" }
    ) {
    articleDrafts(first: $first, after: $after)
      @connection(key: "draftsPaginationFragment_articleDrafts") {
      __id
      edges {
        node {
          id
          uuid
          title
          tags
          updated
        }
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

const DeleteDraftMutation = graphql`
  mutation draftsDeleteMutation(
    $input: DeleteArticleDraftInput!
    $connections: [ID!]!
  ) {
    deleteArticleDraft(input: $input) {
      __typename
      ... on DeleteArticleDraftPayload {
        deletedDraftId @deleteEdge(connections: $connections)
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const loadDraftsQuery = query(
  (first: number = DRAFTS_PAGE_SIZE, after: string | null = null) =>
    loadQuery<draftsQuery>(
      useRelayEnvironment()(),
      DraftsQuery,
      { first, after },
    ),
  "loadArticleDraftsQuery",
);

export const route = {
  preload() {
    void loadDraftsQuery();
  },
} satisfies RouteDefinition;

export default function ArticleDraftsListPage() {
  const { t } = useLingui();
  const params = useParams();

  const data = createPreloadedQuery<draftsQuery>(
    DraftsQuery,
    () => loadDraftsQuery(),
  );

  const draftData = createPaginationFragment(
    DraftsPaginationFragment,
    () => data()?.viewer as draftsPaginationFragment$key,
  );

  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  const loadMoreDrafts = () => {
    setLoadingState("loading");
    draftData.loadNext(DRAFTS_PAGE_SIZE, {
      onComplete: (error) => {
        if (error) {
          setLoadingState("errored");
        } else {
          setLoadingState("loaded");
        }
      },
    });
  };

  const [deleteDraft, isDeleting] = createMutation<draftsDeleteMutation>(
    DeleteDraftMutation,
  );

  const handleDelete = (draftId: string, draftTitle: string) => {
    if (
      !confirm(
        t`Are you sure you want to delete "${draftTitle}"? This action cannot be undone.`,
      )
    ) {
      return;
    }

    const connections: string[] = [];
    const viewerId = data()?.viewer?.id;

    if (viewerId) {
      // Construct connection IDs manually using Relay's naming convention
      // AppSidebar uses @connection(key: "SignedAccount_articleDrafts")
      const sidebarId =
        `client:${viewerId}:__SignedAccount_articleDrafts_connection`;

      // Drafts list page uses @connection(key: "draftsPaginationFragment_articleDrafts")
      const listId =
        `client:${viewerId}:__draftsPaginationFragment_articleDrafts_connection`;

      // FloatingComposeButton uses @connection(key: "FloatingComposeButton_articleDrafts")
      const floatingButtonId =
        `client:${viewerId}:__FloatingComposeButton_articleDrafts_connection`;

      connections.push(sidebarId);
      connections.push(listId);
      connections.push(floatingButtonId);
    }

    deleteDraft({
      variables: {
        input: {
          id: draftId,
        },
        connections,
      },
      onCompleted(response) {
        if (
          response.deleteArticleDraft.__typename === "DeleteArticleDraftPayload"
        ) {
          showToast({
            title: t`Success`,
            description: t`Draft deleted`,
            variant: "success",
          });
        } else if (
          response.deleteArticleDraft.__typename === "InvalidInputError"
        ) {
          showToast({
            title: t`Error`,
            description:
              t`Invalid input: ${response.deleteArticleDraft.inputPath}`,
            variant: "error",
          });
        } else if (
          response.deleteArticleDraft.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to delete a draft`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

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
              ? t`You can only view your own drafts`
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
      <div class="container mx-auto p-6">
        <div class="flex items-center justify-between mb-6">
          <Title>{t`Article Drafts`}</Title>
          <A href={`/@${params.handle!.substring(1)}/drafts/new`}>
            <Button>{t`New Article`}</Button>
          </A>
        </div>

        <Show
          when={draftData()?.articleDrafts.edges &&
            draftData()!.articleDrafts.edges.length > 0}
          fallback={
            <div class="text-center py-12">
              <p class="text-muted-foreground mb-4">
                {t`No drafts yet. Create your first article!`}
              </p>
            </div>
          }
        >
          <div class="grid gap-4">
            <For
              each={draftData()?.articleDrafts.edges.filter((edge) =>
                edge.node != null
              )}
            >
              {(edge) => (
                <div class="p-4 border rounded-lg hover:bg-accent transition-colors">
                  <div class="flex items-start justify-between gap-4">
                    <A
                      href={`/@${
                        params.handle!.substring(1)
                      }/drafts/${edge.node.uuid}`}
                      class="flex-1 min-w-0"
                    >
                      <h3 class="font-semibold text-lg">{edge.node.title}</h3>
                      <div class="flex gap-2 mt-2 flex-wrap">
                        <For each={edge.node.tags.slice(0, 3)}>
                          {(tag) => <Badge variant="outline">{tag}</Badge>}
                        </For>
                        <Show when={edge.node.tags.length > 3}>
                          <Badge variant="outline">
                            +{edge.node.tags.length - 3} more
                          </Badge>
                        </Show>
                      </div>
                      <p class="text-sm text-muted-foreground mt-2">
                        {t`Updated ${
                          new Date(edge.node.updated).toLocaleDateString()
                        }`}
                      </p>
                    </A>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault();
                        handleDelete(edge.node.id, edge.node.title);
                      }}
                      disabled={isDeleting()}
                    >
                      {t`Delete`}
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </div>

          <Show when={draftData.hasNext}>
            <div class="flex justify-center mt-6">
              <Button
                variant="outline"
                onClick={loadingState() === "loading"
                  ? undefined
                  : loadMoreDrafts}
                disabled={draftData.pending || loadingState() === "loading"}
              >
                <Switch>
                  <Match
                    when={draftData.pending || loadingState() === "loading"}
                  >
                    {t`Loading...`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more drafts; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load More`}
                  </Match>
                </Switch>
              </Button>
            </div>
          </Show>
        </Show>
      </div>
    </Show>
  );
}
