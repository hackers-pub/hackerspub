import { type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  createPaginationFragment,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorPreviewCard } from "~/components/ActorPreviewCard.tsx";
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
  sharesArticleEngagementQuery,
  sharesArticleEngagementQuery$data,
} from "./__generated__/sharesArticleEngagementQuery.graphql.ts";
import type { sharesArticleEngagement_article$key } from "./__generated__/sharesArticleEngagement_article.graphql.ts";

const SHARES_QUERY_KEY = "loadArticleSharesQuery";

const sharesArticleEngagementQuery = graphql`
  query sharesArticleEngagementQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
    $actingAccountId: ID
  ) {
    articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $slug) {
      engagementStats {
        shares
        quotes
        reactions
      }
      ...PostCard_post @arguments(actingAccountId: $actingAccountId)
      ...sharesArticleEngagement_article @arguments(
        actingAccountId: $actingAccountId
      )
    }
  }
`;

const loadSharesQuery = routePreloadedQuery(
  (
    handle: string,
    idOrYear: string,
    slug: string,
    actingAccountId: string | null,
  ) =>
    loadQuery<sharesArticleEngagementQuery>(
      useRelayEnvironment()(),
      sharesArticleEngagementQuery,
      { handle, idOrYear, slug, actingAccountId },
      { fetchPolicy: "store-and-network" },
    ),
  SHARES_QUERY_KEY,
);

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

type ArticlePost = NonNullable<
  sharesArticleEngagementQuery$data["articleByYearAndSlug"]
>;

export default function ArticleSharesPage() {
  const params = useParams();
  return (
    <ArticleSharesLoaded
      handle={decodeRouteParam(params.handle!)}
      idOrYear={params.idOrYear!}
      slug={decodeRouteParam(params.slug!)}
    />
  );
}

function ArticleSharesLoaded(
  props: { handle: string; idOrYear: string; slug: string },
) {
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<sharesArticleEngagementQuery>(
    sharesArticleEngagementQuery,
    () =>
      loadSharesQuery(
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
        {(a) => <ArticleSharesBody article={a} base={base()} />}
      </Show>
    </Show>
  );
}

function ArticleSharesBody(props: { article: ArticlePost; base: string }) {
  const { t } = useLingui();
  return (
    <NarrowContainer>
      <Title>{t`Shares`}</Title>
      <div class="my-4 space-y-4">
        <div class="border rounded-xl overflow-hidden">
          <PostCard $post={props.article} />
        </div>
        <EngagementTabs
          base={props.base}
          active="shares"
          shares={props.article.engagementStats.shares}
          quotes={props.article.engagementStats.quotes}
          reactions={props.article.engagementStats.reactions}
        />
        <div class="border rounded-xl overflow-hidden">
          <SharesList
            $article={props.article as sharesArticleEngagement_article$key}
          />
        </div>
      </div>
    </NarrowContainer>
  );
}

function SharesList(
  props: { $article: sharesArticleEngagement_article$key },
) {
  const { t } = useLingui();
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  const shares = createPaginationFragment(
    graphql`
      fragment sharesArticleEngagement_article on Article
        @refetchable(queryName: "sharesArticleEngagementPaginationQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 30 }
          actingAccountId: { type: "ID", defaultValue: null }
        )
      {
        shares(after: $cursor, first: $count)
          @connection(key: "SharesArticleEngagement__shares")
        {
          edges {
            node {
              id
              actor {
                id
                ...ActorPreviewCard_actor @arguments(
                  actingAccountId: $actingAccountId
                )
              }
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
  const edges = () => shares()?.shares.edges ?? [];

  function onLoadMore() {
    setLoadingState("loading");
    shares.loadNext(30, {
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
          {t`No one has shared this yet.`}
        </p>
      }
    >
      <ul class="divide-y">
        <For each={edges()}>
          {(edge) => (
            <Show keyed when={edge.node?.actor}>
              {(actor) => (
                <li>
                  <ActorPreviewCard $actor={actor} />
                </li>
              )}
            </Show>
          )}
        </For>
      </ul>
      <Show when={shares.hasNext}>
        <button
          type="button"
          on:click={loadingState() === "loading" ? undefined : onLoadMore}
          disabled={shares.pending || loadingState() === "loading"}
          class="block w-full cursor-pointer border-t px-4 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Switch>
            <Match when={shares.pending || loadingState() === "loading"}>
              {t`Loading more shares…`}
            </Match>
            <Match when={loadingState() === "errored"}>
              {t`Failed to load more shares; click to retry`}
            </Match>
            <Match when={loadingState() === "loaded"}>
              {t`Load more shares`}
            </Match>
          </Switch>
        </button>
      </Show>
    </Show>
  );
}
