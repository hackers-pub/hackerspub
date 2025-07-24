import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { ActorFollowerList_followers$key } from "./__generated__/ActorFollowerList_followers.graphql.ts";
import { SmallProfileCard } from "./SmallProfileCard.tsx";

export interface ActorFollowerListProps {
  $followers: ActorFollowerList_followers$key;
}

export function ActorFollowerList(props: ActorFollowerListProps) {
  const { t } = useLingui();
  const followers = createPaginationFragment(
    graphql`
      fragment ActorFollowerList_followers on Actor
        @refetchable(queryName: "ActorFollowerListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        __id
        followers(after: $cursor, first: $count)
          @connection(key: "ActorFollowerList_followers")
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
    () => props.$followers,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    followers.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl max-w-prose mx-auto my-4">
      <Show when={followers()}>
        {(data) => (
          <>
            <ul class="divide-y divide-solid">
              <For each={data().followers.edges}>
                {(edge) => (
                  <li>
                    <SmallProfileCard $actor={edge.node} />
                  </li>
                )}
              </For>
            </ul>
            <Show when={followers.hasNext}>
              <div
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                class="block px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary"
              >
                <Switch>
                  <Match
                    when={followers.pending || loadingState() === "loading"}
                  >
                    {t`Loading more followers…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more followers; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more followers`}
                  </Match>
                </Switch>
              </div>
            </Show>
            <Show when={data().followers.edges.length < 1}>
              <div class="px-4 py-8 text-center text-muted-foreground">
                {t`No followers found`}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
