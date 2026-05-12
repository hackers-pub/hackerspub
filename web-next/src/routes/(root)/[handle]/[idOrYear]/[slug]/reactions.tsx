import { sortReactionGroups } from "@hackerspub/models/emoji";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { EngagementTabs } from "~/components/EngagementTabs.tsx";
import { ReactionGroupSection } from "~/components/ReactionGroupSection.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";
import type {
  reactionsArticleEngagementQuery,
  reactionsArticleEngagementQuery$data,
} from "./__generated__/reactionsArticleEngagementQuery.graphql.ts";

const REACTIONS_QUERY_KEY = "loadArticleReactionsQuery";

const reactionsArticleEngagementQuery = graphql`
  query reactionsArticleEngagementQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
  ) {
    articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $slug) {
      id
      engagementStats {
        shares
        quotes
        reactions
      }
      reactionGroups {
        __typename
        ... on EmojiReactionGroup {
          emoji
          reactors(first: 20) {
            totalCount
            edges {
              node {
                id
                ...ActorPreviewCard_actor
              }
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
        ... on CustomEmojiReactionGroup {
          customEmoji {
            id
            name
            imageUrl
          }
          reactors(first: 20) {
            totalCount
            edges {
              node {
                id
                ...ActorPreviewCard_actor
              }
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      }
    }
  }
`;

const loadReactionsQuery = routePreloadedQuery(
  (handle: string, idOrYear: string, slug: string) =>
    loadQuery<reactionsArticleEngagementQuery>(
      useRelayEnvironment()(),
      reactionsArticleEngagementQuery,
      { handle, idOrYear, slug },
      { fetchPolicy: "store-and-network" },
    ),
  REACTIONS_QUERY_KEY,
);

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    void loadReactionsQuery(
      args.params.handle!,
      args.params.idOrYear!,
      args.params.slug!,
    );
  },
} satisfies RouteDefinition;

type ArticlePost = NonNullable<
  reactionsArticleEngagementQuery$data["articleByYearAndSlug"]
>;

// Drop Relay's forward-compatible "%other" `__typename` branch so the
// remaining union satisfies `sortReactionGroups`'s generic constraint.
type ReactionGroup = Exclude<
  ArticlePost["reactionGroups"][number],
  { readonly __typename: "%other" }
>;

export default function ArticleReactionsPage() {
  const params = useParams();
  return (
    <ArticleReactionsLoaded
      handle={params.handle!}
      idOrYear={params.idOrYear!}
      slug={params.slug!}
    />
  );
}

function ArticleReactionsLoaded(
  props: { handle: string; idOrYear: string; slug: string },
) {
  const data = createPreloadedQuery<reactionsArticleEngagementQuery>(
    reactionsArticleEngagementQuery,
    () => loadReactionsQuery(props.handle, props.idOrYear, props.slug),
  );
  const article = (): ArticlePost | null =>
    data()?.articleByYearAndSlug ?? null;
  const base = () => `/${props.handle}/${props.idOrYear}/${props.slug}`;
  return (
    <Show when={data() != null}>
      <Show keyed when={article()} fallback={<NotFoundPage embedded />}>
        {(a) => <ArticleReactionsBody article={a} base={base()} />}
      </Show>
    </Show>
  );
}

function ArticleReactionsBody(props: { article: ArticlePost; base: string }) {
  const { t } = useLingui();
  const knownGroups = () =>
    props.article.reactionGroups.filter(
      (g): g is ReactionGroup =>
        g.__typename === "EmojiReactionGroup" ||
        g.__typename === "CustomEmojiReactionGroup",
    );
  const groups = () => sortReactionGroups(knownGroups());
  return (
    <NarrowContainer>
      <Title>{t`Reactions`}</Title>
      <div class="my-4">
        <EngagementTabs
          base={props.base}
          active="reactions"
          shares={props.article.engagementStats.shares}
          quotes={props.article.engagementStats.quotes}
          reactions={props.article.engagementStats.reactions}
        />
        <Show
          when={groups().length > 0}
          fallback={
            <p class="mt-4 p-6 text-center text-sm text-muted-foreground border rounded-xl">
              {t`No reactions yet.`}
            </p>
          }
        >
          <div class="mt-4 divide-y border rounded-xl overflow-hidden">
            <For each={groups()}>
              {(group) => (
                <ReactionGroupSection
                  postNodeId={props.article.id}
                  totalCount={group.reactors.totalCount}
                  initialReactors={group.reactors.edges.flatMap((e) =>
                    e.node == null ? [] : [e.node]
                  )}
                  initialEndCursor={group.reactors.pageInfo.endCursor ?? null}
                  initialHasNextPage={group.reactors.pageInfo.hasNextPage}
                  emoji={group.__typename === "EmojiReactionGroup"
                    ? group.emoji
                    : null}
                  customEmojiNodeId={group.__typename ===
                      "CustomEmojiReactionGroup"
                    ? group.customEmoji.id
                    : null}
                  header={
                    <header class="flex items-center gap-2 bg-muted/40 px-4 py-2 text-sm font-medium">
                      <Show
                        when={group.__typename === "EmojiReactionGroup"}
                        fallback={
                          <Show
                            keyed
                            when={group.__typename ===
                                "CustomEmojiReactionGroup"
                              ? group.customEmoji
                              : null}
                          >
                            {(emoji) => (
                              <img
                                src={emoji.imageUrl}
                                alt={emoji.name}
                                class="size-5"
                              />
                            )}
                          </Show>
                        }
                      >
                        <span class="text-base leading-none">
                          {group.__typename === "EmojiReactionGroup"
                            ? group.emoji
                            : ""}
                        </span>
                      </Show>
                      <span class="text-muted-foreground">
                        {group.reactors.totalCount}
                      </span>
                    </header>
                  }
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </NarrowContainer>
  );
}
