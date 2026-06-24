import { graphql } from "relay-runtime";
import {
  createEffect,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { ArticleCard } from "./ArticleCard.tsx";
import { ActorArticleList_articles$key } from "./__generated__/ActorArticleList_articles.graphql.ts";

export interface ActorArticleListProps {
  $articles: ActorArticleList_articles$key;
}

export function ActorArticleList(props: ActorArticleListProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const articles = createPaginationFragment(
    graphql`
      fragment ActorArticleList_articles on Actor
        @refetchable(queryName: "ActorArticleListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
          actingAccountId: { type: "ID" }
          locale: { type: "Locale" }
        )
      {
        __id
        articles(
          after: $cursor
          first: $count
          actingAccountId: $actingAccountId
        )
          @connection(key: "ActorArticleList_articles")
        {
          __id
          edges {
            __id
            node {
              ...ArticleCard_article @arguments(
                locale: $locale
                actingAccountId: $actingAccountId
              )
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
  const actingAccountId = () => actingAccount.selectedActingAccountId();

  createEffect(on(
    actingAccountId,
    (actingAccountId) =>
      articles.refetch({ actingAccountId: actingAccountId ?? null }),
    { defer: true },
  ));

  function onLoadMore() {
    setLoadingState("loading");
    articles.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <Show keyed when={articles()}>
        {(data) => (
          <>
            <For each={data.articles.edges}>
              {(edge) => (
                <ArticleCard
                  $article={edge.node}
                  connections={[data.articles.__id]}
                />
              )}
            </For>
            <Show when={articles.hasNext}>
              <button
                type="button"
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                disabled={articles.pending || loadingState() === "loading"}
                class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
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
              </button>
            </Show>
            <Show when={data.articles.edges.length < 1}>
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
