import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.ts";
import { ActorFollowingList_following$key } from "./__generated__/ActorFollowingList_following.graphql.ts";
import { SmallProfileCard } from "./SmallProfileCard.tsx";

export interface ActorFollowingListProps {
  $following: ActorFollowingList_following$key;
}

export function ActorFollowingList(props: ActorFollowingListProps) {
  const { t } = useLingui();
  const following = createPaginationFragment(
    graphql`
      fragment ActorFollowingList_following on Actor
      @refetchable(queryName: "ActorFollowingListQuery")
      @argumentDefinitions(
        cursor: { type: "String" }
        count: { type: "Int", defaultValue: 20 }
        actingAccountId: { type: "ID", defaultValue: null }
      ) {
        __id
        followees(after: $cursor, first: $count)
          @connection(key: "ActorFollowingList_followees") {
          edges {
            __id
            node {
              ...SmallProfileCard_actor
                @arguments(actingAccountId: $actingAccountId)
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$following,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    following.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <Show keyed when={following()}>
        {(data) => (
          <>
            <ul class="divide-y divide-solid">
              <For each={data.followees.edges}>
                {(edge) => (
                  <li>
                    <SmallProfileCard $actor={edge.node} />
                  </li>
                )}
              </For>
            </ul>
            <Show when={following.hasNext}>
              <button
                type="button"
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                disabled={following.pending || loadingState() === "loading"}
                class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Switch>
                  <Match
                    when={following.pending || loadingState() === "loading"}
                  >
                    {t`Loading more following…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more following; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more following`}
                  </Match>
                </Switch>
              </button>
            </Show>
            <Show when={data.followees.edges.length < 1}>
              <div class="px-4 py-8 text-center text-muted-foreground">
                {t`No following found`}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
