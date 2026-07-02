import { type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  createPaginationFragment,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { EngagementTabs } from "~/components/EngagementTabs.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { PostCard } from "~/components/PostCard.tsx";
import { Title } from "~/components/Title.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type {
  quotesArticleEngagementQuery,
  quotesArticleEngagementQuery$data,
} from "./__generated__/quotesArticleEngagementQuery.graphql.ts";
import type { quotesArticleEngagement_article$key } from "./__generated__/quotesArticleEngagement_article.graphql.ts";

const QUOTES_QUERY_KEY = "loadArticleQuotesQuery";

const quotesArticleEngagementQuery = graphql`
  query quotesArticleEngagementQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
    $actingAccountId: ID
  ) {
    articleByYearAndSlug(
      handle: $handle
      idOrYear: $idOrYear
      slug: $slug
      actingAccountId: $actingAccountId
    ) {
      engagementStats {
        shares
        quotes
        reactions
      }
      ...PostCard_post @arguments(actingAccountId: $actingAccountId)
      ...quotesArticleEngagement_article @arguments(
        actingAccountId: $actingAccountId
      )
    }
  }
`;

const loadQuotesQuery = routePreloadedQuery(
  (
    handle: string,
    idOrYear: string,
    slug: string,
    actingAccountId: string | null,
  ) =>
    loadQuery<quotesArticleEngagementQuery>(
      useRelayEnvironment()(),
      quotesArticleEngagementQuery,
      { handle, idOrYear, slug, actingAccountId },
      { fetchPolicy: "store-and-network" },
    ),
  QUOTES_QUERY_KEY,
);

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

type ArticlePost = NonNullable<
  quotesArticleEngagementQuery$data["articleByYearAndSlug"]
>;

export default function ArticleQuotesPage() {
  const params = useParams();
  return (
    <ArticleQuotesLoaded
      handle={decodeRouteParam(params.handle!)}
      idOrYear={params.idOrYear!}
      slug={decodeRouteParam(params.slug!)}
    />
  );
}

function ArticleQuotesLoaded(
  props: { handle: string; idOrYear: string; slug: string },
) {
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<quotesArticleEngagementQuery>(
    quotesArticleEngagementQuery,
    () =>
      loadQuotesQuery(
        props.handle,
        props.idOrYear,
        props.slug,
        actingAccountId() ?? null,
      ),
  );
  const article = (): ArticlePost | null =>
    data()?.articleByYearAndSlug ?? null;
  const base = () => `/${props.handle}/${props.idOrYear}/${props.slug}`;
  return (
    <Show when={data() != null}>
      <Show keyed when={article()} fallback={<NotFoundPage embedded />}>
        {(a) => <ArticleQuotesBody article={a} base={base()} />}
      </Show>
    </Show>
  );
}

function ArticleQuotesBody(props: { article: ArticlePost; base: string }) {
  const { t } = useLingui();
  return (
    <NarrowContainer>
      <Title>{t`Quotes`}</Title>
      <div class="my-4 space-y-4">
        <div class="border rounded-xl overflow-hidden">
          <PostCard $post={props.article} />
        </div>
        <EngagementTabs
          base={props.base}
          active="quotes"
          shares={props.article.engagementStats.shares}
          quotes={props.article.engagementStats.quotes}
          reactions={props.article.engagementStats.reactions}
        />
        <div class="border rounded-xl overflow-hidden">
          <QuotesList
            $article={props.article as quotesArticleEngagement_article$key}
          />
        </div>
      </div>
    </NarrowContainer>
  );
}

function QuotesList(
  props: { $article: quotesArticleEngagement_article$key },
) {
  const { t } = useLingui();
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  const quotes = createPaginationFragment(
    graphql`
      fragment quotesArticleEngagement_article on Article
        @refetchable(queryName: "quotesArticleEngagementPaginationQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
          actingAccountId: { type: "ID", defaultValue: null }
        )
      {
        quotes(after: $cursor, first: $count, actingAccountId: $actingAccountId)
          @connection(key: "QuotesArticleEngagement__quotes")
        {
          edges {
            node {
              id
              ...PostCard_post @arguments(actingAccountId: $actingAccountId)
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$article,
  );
  const edges = () => quotes()?.quotes.edges ?? [];

  function onLoadMore() {
    setLoadingState("loading");
    quotes.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <Show
      when={edges().length > 0}
      fallback={
        <p class="p-6 text-center text-sm text-muted-foreground">
          {t`No one has quoted this yet.`}
        </p>
      }
    >
      <For each={edges()}>
        {(edge) => (
          <Show keyed when={edge.node}>
            {(quote) => <PostCard $post={quote} />}
          </Show>
        )}
      </For>
      <Show when={quotes.hasNext}>
        <button
          type="button"
          on:click={loadingState() === "loading" ? undefined : onLoadMore}
          disabled={quotes.pending || loadingState() === "loading"}
          class="block w-full cursor-pointer border-t px-4 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Switch>
            <Match when={quotes.pending || loadingState() === "loading"}>
              {t`Loading more quotes…`}
            </Match>
            <Match when={loadingState() === "errored"}>
              {t`Failed to load more quotes; click to retry`}
            </Match>
            <Match when={loadingState() === "loaded"}>
              {t`Load more quotes`}
            </Match>
          </Switch>
        </button>
      </Show>
    </Show>
  );
}
