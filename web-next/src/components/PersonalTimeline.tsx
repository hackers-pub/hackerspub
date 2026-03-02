import { graphql } from "relay-runtime";
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { PostCard } from "~/components/PostCard.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { PersonalTimeline_posts$key } from "./__generated__/PersonalTimeline_posts.graphql.ts";

export interface PersonalTimelineProps {
  $posts: PersonalTimeline_posts$key;
}

export function PersonalTimeline(props: PersonalTimelineProps) {
  const { t } = useLingui();
  const { onNoteCreated } = useNoteCompose();
  const posts = createPaginationFragment(
    graphql`
      fragment PersonalTimeline_posts on Query
        @refetchable(queryName: "PersonalTimelineQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 25 }
          locale: { type: "Locale" }
          local: { type: "Boolean", defaultValue: false }
          postType: { type: "PostType", defaultValue: null }
          withoutShares: { type: "Boolean", defaultValue: false }
        )
      {
        __id
        personalTimeline(
          after: $cursor,
          first: $count,
          local: $local,
          postType: $postType,
          withoutShares: $withoutShares,
        )
          @connection(key: "PersonalTimeline__personalTimeline")
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

  onMount(() => {
    const cleanup = onNoteCreated(() => {
      // TODO: Refetch the timeline when a note is created with keeping old data visible
      posts.refetch({});
    });
    return cleanup;
  });

  function onLoadMore() {
    setLoadingState("loading");
    posts.loadNext(25, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="border-x max-w-prose mx-auto">
      <Show when={posts()}>
        {(data) => (
          <>
            <For each={data().personalTimeline.edges}>
              {(edge) => (
                <PostCard
                  $post={edge.node}
                  connections={[data().personalTimeline.__id]}
                />
              )}
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
            <Show when={data().personalTimeline.edges.length < 1}>
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
