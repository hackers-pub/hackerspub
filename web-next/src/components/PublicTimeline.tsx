import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { PostCard } from "~/components/PostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { PublicTimeline_posts$key } from "./__generated__/PublicTimeline_posts.graphql.ts";

export interface PublicTimelineProps {
  $posts: PublicTimeline_posts$key;
}

export function PublicTimeline(props: PublicTimelineProps) {
  const { t } = useLingui();
  const posts = createPaginationFragment(
    graphql`
      fragment PublicTimeline_posts on Query 
        @refetchable(queryName: "PublicTimelineQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 25 }
          locale: { type: "Locale" }
        )
      {
        __id
        publicTimeline(after: $cursor, first: $count)
          @connection(key: "PublicTimeline__publicTimeline")
        {
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
    posts.loadNext(25, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl max-w-prose mx-auto my-4">
      <Show when={posts()}>
        {(data) => (
          <>
            <For each={data().publicTimeline.edges}>
              {(edge) => <PostCard $post={edge.node} />}
            </For>
            <Show when={posts.hasNext}>
              <div
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                class="block px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary"
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
              </div>
            </Show>
            <Show when={data().publicTimeline.edges.length < 1}>
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
