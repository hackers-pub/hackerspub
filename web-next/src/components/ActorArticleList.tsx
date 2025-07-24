import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { ArticleCard } from "./ArticleCard.tsx";
import { ActorArticleList_articles$key } from "./__generated__/ActorArticleList_articles.graphql.ts";

export interface ActorArticleListProps {
  $articles: ActorArticleList_articles$key;
}

export function ActorArticleList(props: ActorArticleListProps) {
  const { t } = useLingui();
  const articles = createPaginationFragment(
    graphql`
      fragment ActorArticleList_articles on Actor
        @refetchable(queryName: "ActorArticleListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
          locale: { type: "Locale" }
        )
      {
        __id
        articles(after: $cursor, first: $count)
          @connection(key: "ActorArticleList_articles")
        {
          edges {
            __id
            node {
              ...ArticleCard_article @arguments(locale: $locale)
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$articles,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    articles.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl max-w-prose mx-auto my-4">
      <Show when={articles()}>
        {(data) => (
          <>
            <For each={data().articles.edges}>
              {(edge) => <ArticleCard $article={edge.node} />}
            </For>
            <Show when={articles.hasNext}>
              <div
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                class="block px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary"
              >
                <Switch>
                  <Match
                    when={articles.pending || loadingState() === "loading"}
                  >
                    {t`Loading more articles…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more articles; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more articles`}
                  </Match>
                </Switch>
              </div>
            </Show>
            <Show when={data().articles.edges.length < 1}>
              <div class="px-4 py-8 text-center text-muted-foreground">
                {t`No notes articles`}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
