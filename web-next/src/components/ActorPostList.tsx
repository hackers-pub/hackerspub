import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { ActorPostList_posts$key } from "./__generated__/ActorPostList_posts.graphql.ts";
import { PostCard } from "./PostCard.tsx";

export interface ActorPostListProps {
  $posts: ActorPostList_posts$key;
  pinConnections?: string[];
}

export function ActorPostList(props: ActorPostListProps) {
  const { t } = useLingui();
  const posts = createPaginationFragment(
    graphql`
      fragment ActorPostList_posts on Actor
        @refetchable(queryName: "ActorPostListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
          locale: { type: "Locale" }
        )
      {
        __id
        posts(after: $cursor, first: $count)
          @connection(key: "ActorPostList_posts")
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
    () => props.$posts,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    posts.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <Show keyed when={posts()}>
        {(data) => (
          <>
            <For each={data.posts.edges}>
              {(edge) => (
                <PostCard
                  $post={edge.node}
                  connections={[data.posts.__id]}
                  pinConnections={props.pinConnections}
                />
              )}
            </For>
            <Show when={posts.hasNext}>
              <button
                type="button"
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                disabled={posts.pending || loadingState() === "loading"}
                class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Switch>
                  <Match when={posts.pending || loadingState() === "loading"}>
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
            <Show when={data.posts.edges.length < 1}>
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
