import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ArticleCard } from "~/components/ArticleCard.tsx";
import { ArticleSharerList } from "~/components/ArticleSharerList.tsx";
import { PostReactionsNav } from "~/components/PostReactionsNav.tsx";
import type { sharesArticlePageQuery as SharesArticlePageQueryType } from "./__generated__/sharesArticlePageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    void loadPageQuery(
      args.params.handle,
      args.params.idOrYear,
      args.params.slug,
    );
  },
} satisfies RouteDefinition;

const sharesArticlePageQuery = graphql`
  query sharesArticlePageQuery($handle: String!, $idOrYear: String!, $slug: String!) {
    articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $slug) {
      id
      actor {
        username
      }
      publishedYear
      slug
      engagementStats {
        reactions
        shares
      }
      ...ArticleCard_article
      ...ArticleSharerList_article
    }
  }
`;

const loadPageQuery = query(
  (handle: string, idOrYear: string, slug: string) =>
    loadQuery<SharesArticlePageQueryType>(
      useRelayEnvironment()(),
      sharesArticlePageQuery,
      {
        handle,
        idOrYear,
        slug,
      },
    ),
  "loadArticleSharesQuery",
);

export default function SharesArticlePage() {
  const params = useParams();
  const data = createPreloadedQuery<SharesArticlePageQueryType>(
    sharesArticlePageQuery,
    () => loadPageQuery(params.handle, params.idOrYear, params.slug),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <Show when={data().articleByYearAndSlug}>
          {(article) => (
            <div class="p-4">
              <div class="border rounded-xl overflow-hidden mb-8">
                <ArticleCard $article={article()} />
              </div>

              <PostReactionsNav
                active="shares"
                hrefs={{
                  reactions:
                    `/@${article().actor.username}/${article().publishedYear}/${article().slug}/reactions`,
                  shares:
                    `/@${article().actor.username}/${article().publishedYear}/${article().slug}/shares`,
                }}
                stats={{
                  reactions: article().engagementStats.reactions,
                  shares: article().engagementStats.shares,
                }}
              />

              <ArticleSharerList $article={article()} />
            </div>
          )}
        </Show>
      )}
    </Show>
  );
}
