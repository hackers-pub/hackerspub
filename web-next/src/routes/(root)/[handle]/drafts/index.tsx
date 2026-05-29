import { A, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { HttpStatusCode } from "@solidjs/start";
import { ConnectionHandler, graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  createMutation,
  createPaginationFragment,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import IconFilePlus2 from "~icons/lucide/file-plus-2";
import IconTrash2 from "~icons/lucide/trash-2";
import { Badge } from "~/components/ui/badge.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle as UICardTitle,
} from "~/components/ui/card.tsx";
import { Title } from "~/components/Title.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import { showToast } from "~/components/ui/toast.tsx";
import type { draftsQuery } from "./__generated__/draftsQuery.graphql.ts";
import type { draftsDeleteMutation } from "./__generated__/draftsDeleteMutation.graphql.ts";
import type { draftsPaginationFragment$key } from "./__generated__/draftsPaginationFragment.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

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

const loadDraftsQuery = routePreloadedQuery(
  (first: number = DRAFTS_PAGE_SIZE, after: string | null = null) =>
    loadQuery<draftsQuery>(
      useRelayEnvironment()(),
      DraftsQuery,
      { first, after },
    ),
  "loadArticleDraftsQuery",
);

export default function ArticleDraftsListPage() {
  const { t, i18n } = useLingui();
  const params = useParams();

  const data = createStablePreloadedQuery<draftsQuery>(
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
  const draftConnections = () => {
    const viewerId = data()?.viewer?.id;
    if (viewerId == null) return [];

    return [
      ConnectionHandler.getConnectionID(
        viewerId,
        "SignedAccount_articleDrafts",
      ),
      draftData()?.articleDrafts.__id,
      ConnectionHandler.getConnectionID(
        viewerId,
        "FloatingComposeButton_articleDrafts",
      ),
    ].filter((id): id is string => id != null);
  };

  const handleDelete = (draftId: string, draftTitle: string) => {
    if (
      !confirm(
        t`Are you sure you want to delete "${draftTitle}"? This action cannot be undone.`,
      )
    ) {
      return;
    }

    deleteDraft({
      variables: {
        input: {
          id: draftId,
        },
        connections: draftConnections(),
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
      when={data()?.viewer?.username ===
        decodeRouteParam(params.handle!).substring(1)}
      fallback={
        <WideContainer class="px-4 py-6 sm:px-6 lg:py-8">
          <HttpStatusCode code={403} />
          <Title>{t`Permission denied`}</Title>
          <Card class="mx-auto max-w-xl">
            <CardHeader>
              <UICardTitle>{t`Permission denied`}</UICardTitle>
              <CardDescription>
                {data()?.viewer
                  ? t`You can only view your own drafts`
                  : t`Please sign in to access this page`}
              </CardDescription>
            </CardHeader>
            <CardContent class="flex flex-wrap gap-2">
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
            </CardContent>
          </Card>
        </WideContainer>
      }
    >
      <WideContainer class="px-4 py-6 sm:px-6 lg:py-8">
        <div class="mx-auto max-w-4xl">
          <div class="mb-6 flex items-center justify-between gap-3">
            <div>
              <Title>{t`Article drafts`}</Title>
              <h1 class="text-2xl font-semibold tracking-tight">
                {t`Article drafts`}
              </h1>
            </div>
            <A href={`/@${params.handle!.substring(1)}/drafts/new`}>
              <Button class="gap-2">
                <IconFilePlus2 class="size-4" />
                {t`New article`}
              </Button>
            </A>
          </div>

          <Show
            when={draftData()?.articleDrafts.edges &&
              draftData()!.articleDrafts.edges.length > 0}
            fallback={
              <Card>
                <CardContent class="py-12 text-center text-muted-foreground">
                  {t`No drafts yet. Create your first article!`}
                </CardContent>
              </Card>
            }
          >
            <div class="grid gap-3">
              <For
                each={draftData()?.articleDrafts.edges.filter((edge) =>
                  edge.node != null
                )}
              >
                {(edge) => (
                  <Card class="transition-colors hover:bg-accent/40">
                    <CardContent class="p-4">
                      <div class="flex items-start justify-between gap-4">
                        <A
                          href={`/@${
                            params.handle!.substring(1)
                          }/drafts/${edge.node.uuid}`}
                          class="min-w-0 flex-1"
                        >
                          <h3 class="truncate text-lg font-semibold">
                            {edge.node.title}
                          </h3>
                          <div class="mt-2 flex flex-wrap gap-2">
                            <For each={edge.node.tags.slice(0, 3)}>
                              {(tag) => <Badge variant="outline">{tag}</Badge>}
                            </For>
                            <Show when={edge.node.tags.length > 3}>
                              <Badge variant="outline">
                                {i18n._(
                                  msg`${
                                    plural(edge.node.tags.length - 3, {
                                      one: "+1 more",
                                      other: "+# more",
                                    })
                                  }`,
                                )}
                              </Badge>
                            </Show>
                          </div>
                          <p class="mt-2 text-sm text-muted-foreground">
                            {t`Updated ${
                              new Date(edge.node.updated).toLocaleDateString()
                            }`}
                          </p>
                        </A>
                        <Button
                          variant="destructive"
                          size="sm"
                          class="gap-2"
                          onClick={(e) => {
                            e.preventDefault();
                            handleDelete(edge.node.id, edge.node.title);
                          }}
                          disabled={isDeleting()}
                        >
                          <IconTrash2 class="size-4" />
                          {t`Delete`}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
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
                      {t`Loading…`}
                    </Match>
                    <Match when={loadingState() === "errored"}>
                      {t`Failed to load more drafts; click to retry`}
                    </Match>
                    <Match when={loadingState() === "loaded"}>
                      {t`Load more`}
                    </Match>
                  </Switch>
                </Button>
              </div>
            </Show>
          </Show>
        </div>
      </WideContainer>
    </Show>
  );
}
