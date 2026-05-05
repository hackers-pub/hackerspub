import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostCard } from "./PostCard.tsx";
import { ActorSharedPostList_sharedPosts$key } from "./__generated__/ActorSharedPostList_sharedPosts.graphql.ts";

export interface ActorSharedPostListProps {
  $sharedPosts: ActorSharedPostList_sharedPosts$key;
}

export function ActorSharedPostList(props: ActorSharedPostListProps) {
  const { t } = useLingui();
  const sharedPosts = createPaginationFragment(
    graphql`
      fragment ActorSharedPostList_sharedPosts on Actor
        @refetchable(queryName: "ActorSharedPostListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
          locale: { type: "Locale" }
        )
      {
        __id
        sharedPosts(after: $cursor, first: $count)
          @connection(key: "ActorSharedPostList_sharedPosts")
        {
          __id
          edges {
            __id
            node {
              ...PostCard_post @arguments(locale: $locale)
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$sharedPosts,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    sharedPosts.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <Show keyed when={sharedPosts()}>
        {(data) => (
          <>
            <For each={data.sharedPosts.edges}>
              {(edge) => (
                <PostCard
                  $post={edge.node}
                  connections={[data.sharedPosts.__id]}
                />
              )}
            </For>
            <Show when={sharedPosts.hasNext}>
              <button
                type="button"
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                disabled={sharedPosts.pending || loadingState() === "loading"}
                class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Switch>
                  <Match
                    when={sharedPosts.pending || loadingState() === "loading"}
                  >
                    {t`Loading more posts…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more posts; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more posts`}
                  </Match>
                </Switch>
              </button>
            </Show>
            <Show when={data.sharedPosts.edges.length < 1}>
              <div class="px-4 py-8 text-center text-muted-foreground">
                {t`No posts found`}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
