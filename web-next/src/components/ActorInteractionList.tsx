import { graphql } from "relay-runtime";
import {
  createEffect,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ActorInteractionList_interactions$key } from "./__generated__/ActorInteractionList_interactions.graphql.ts";
import { PostCard } from "./PostCard.tsx";

export interface ActorInteractionListProps {
  $interactions: ActorInteractionList_interactions$key;
}

export function ActorInteractionList(props: ActorInteractionListProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const interactions = createPaginationFragment(
    graphql`
      fragment ActorInteractionList_interactions on Actor
        @refetchable(queryName: "ActorInteractionListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
          actingAccountId: { type: "ID" }
          locale: { type: "Locale" }
        )
      {
        __id
        viewerInteractions(after: $cursor, first: $count)
          @connection(key: "ActorInteractionList_viewerInteractions")
        {
          __id
          edges {
            __id
            node {
              ...PostCard_post @arguments(
                locale: $locale
                actingAccountId: $actingAccountId
              )
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$interactions,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  const actingAccountId = () => actingAccount.selectedActingAccountId();

  createEffect(on(
    actingAccountId,
    (actingAccountId) =>
      interactions.refetch({ actingAccountId: actingAccountId ?? null }),
    { defer: true },
  ));

  function onLoadMore() {
    setLoadingState("loading");
    interactions.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }
  const interactionEdges = () =>
    interactions()?.viewerInteractions?.edges ?? [];
  const interactionConnections = () => {
    const connectionId = interactions()?.viewerInteractions?.__id;
    return connectionId == null ? [] : [connectionId];
  };
  const hasNoInteractions = () => {
    const edges = interactions()?.viewerInteractions?.edges;
    return edges != null && edges.length === 0;
  };

  return (
    <div class="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <Show when={interactions()}>
        <For each={interactionEdges()}>
          {(edge) => (
            <PostCard
              $post={edge.node}
              connections={interactionConnections()}
            />
          )}
        </For>
        <Show when={interactions.hasNext}>
          <button
            type="button"
            onClick={loadingState() === "loading" ? undefined : onLoadMore}
            disabled={interactions.isLoadingNext ||
              loadingState() === "loading"}
            class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Switch>
              <Match
                when={interactions.isLoadingNext ||
                  loadingState() === "loading"}
              >
                {t`Loading more interactions…`}
              </Match>
              <Match when={loadingState() === "errored"}>
                {t`Failed to load more interactions; click to retry`}
              </Match>
              <Match when={loadingState() === "loaded"}>
                {t`Load more interactions`}
              </Match>
            </Switch>
          </button>
        </Show>
        <Show when={hasNoInteractions()}>
          <div class="px-4 py-8 text-center text-muted-foreground">
            {t`No interactions found`}
          </div>
        </Show>
      </Show>
    </div>
  );
}
