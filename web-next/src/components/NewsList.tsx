import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  createEffect,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { NewsStoryCard } from "~/components/NewsStoryCard.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { NewsSort } from "~/lib/useNewsSort.ts";
import type { NewsList_stories$key } from "./__generated__/NewsList_stories.graphql.ts";

export interface NewsListProps {
  $stories: NewsList_stories$key;
  activeSort: () => NewsSort;
  buildHref: (sort: NewsSort) => string;
}

export function NewsList(props: NewsListProps) {
  const { t } = useLingui();
  const { onNoteCreated } = useNoteCompose();
  const stories = createPaginationFragment(
    graphql`
      fragment NewsList_stories on Query
      @refetchable(queryName: "NewsListQuery")
      @argumentDefinitions(
        cursor: { type: "String" }
        count: { type: "Int", defaultValue: 25 }
        order: { type: "NewsOrder", defaultValue: POPULAR }
      ) {
        __id
        viewer {
          moderator
        }
        newsStories(after: $cursor, first: $count, order: $order)
          @connection(key: "NewsList__newsStories") {
          __id
          edges {
            __id
            cursor
            node {
              ...NewsStoryCard_story
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$stories,
  );

  // Refetch at the fragment level when the sort pill changes after mount, so
  // the subtree stays mounted (no flash). The top-level query carries the
  // initial sort for SSR.
  createEffect(
    on(
      () => props.activeSort(),
      (order) => {
        stories.refetch({ order });
      },
      { defer: true },
    ),
  );

  onMount(() => {
    // Stale-while-revalidate, and refresh when the viewer shares a link (the
    // new share re-scores it, so it should surface immediately).
    stories.refetch({ order: props.activeSort() });
    onCleanup(
      onNoteCreated(() => {
        stories.refetch({ order: props.activeSort() });
      }),
    );
  });

  function onLoadMore() {
    stories.loadNext(25);
  }

  const sortPills: { value: NewsSort; label: () => string }[] = [
    { value: "POPULAR", label: () => t`Popular` },
    { value: "NEWEST", label: () => t`Newest` },
    { value: "ALL_TIME", label: () => t`All-time` },
  ];

  const pillClass = (active: boolean) =>
    [
      "rounded-full border px-3 py-1.5 text-sm transition-colors",
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    ].join(" ");

  return (
    <>
      <div class="flex flex-wrap gap-2 border-b px-4 py-3">
        <For each={sortPills}>
          {(pill) => (
            <A
              href={props.buildHref(pill.value)}
              class={pillClass(props.activeSort() === pill.value)}
            >
              {pill.label()}
            </A>
          )}
        </For>
      </div>
      <div class="mt-4 mb-10 overflow-hidden border bg-card md:mb-12 md:rounded-lg md:shadow-sm">
        <Show keyed when={stories()}>
          {(data) => (
            <>
              <For each={data.newsStories.edges}>
                {(edge) => (
                  <NewsStoryCard
                    $story={edge.node}
                    moderator={data.viewer?.moderator ?? false}
                    onPenaltyChanged={() =>
                      stories.refetch(
                        { order: props.activeSort() },
                        { fetchPolicy: "network-only" },
                      )
                    }
                  />
                )}
              </For>
              <Show when={stories.hasNext}>
                <button
                  type="button"
                  on:click={stories.pending ? undefined : onLoadMore}
                  disabled={stories.pending}
                  class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Switch fallback={t`Load more stories`}>
                    <Match when={stories.pending}>
                      {t`Loading more stories…`}
                    </Match>
                  </Switch>
                </button>
              </Show>
              <Show when={data.newsStories.edges.length < 1}>
                <div class="px-4 py-16 text-center text-muted-foreground">
                  {t`No shared links yet. Once links start circulating across the fediverse, they will appear here.`}
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </>
  );
}
