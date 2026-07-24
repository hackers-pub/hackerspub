import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.ts";
import { ActorFollowerList_followers$key } from "./__generated__/ActorFollowerList_followers.graphql.ts";
import { RemoveFollowerButton } from "./RemoveFollowerButton.tsx";
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
        actingAccountId: { type: "ID", defaultValue: null }
      ) {
        __id
        isViewer(actingAccountId: $actingAccountId)
        followers(after: $cursor, first: $count)
          @connection(key: "ActorFollowerList_followers") {
          __id
          edges {
            __id
            node {
              ...RemoveFollowerButton_actor
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
    <div class="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <Show keyed when={followers()}>
        {(data) => (
          <>
            <ul class="divide-y divide-solid">
              <For each={data.followers.edges}>
                {(edge) => (
                  <li>
                    <SmallProfileCard
                      $actor={edge.node}
                      rightAction={
                        <Show when={data.isViewer}>
                          <RemoveFollowerButton
                            $actor={edge.node}
                            connectionId={data.followers.__id}
                          />
                        </Show>
                      }
                    />
                  </li>
                )}
              </For>
            </ul>
            <Show when={followers.hasNext}>
              <button
                type="button"
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                disabled={followers.pending || loadingState() === "loading"}
                class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
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
              </button>
            </Show>
            <Show when={data.followers.edges.length < 1}>
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
