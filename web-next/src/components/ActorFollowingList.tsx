import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
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
        )
      {
        __id
        followees(after: $cursor, first: $count)
          @connection(key: "ActorFollowingList_followees")
        {
          edges {
            __id
            node {
              ...SmallProfileCard_actor
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
    <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl max-w-prose mx-auto my-4">
      <Show when={following()}>
        {(data) => (
          <>
            <ul class="divide-y divide-solid">
              <For each={data().followees.edges}>
                {(edge) => (
                  <li>
                    <SmallProfileCard $actor={edge.node} />
                  </li>
                )}
              </For>
            </ul>
            <Show when={following.hasNext}>
              <div
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                class="block px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary"
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
              </div>
            </Show>
            <Show when={data().followees.edges.length < 1}>
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
