import { Meta } from "@solidjs/meta";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorArticleList } from "~/components/ActorArticleList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NavigateIfHandleIsNotCanonical } from "~/components/NavigateIfHandleIsNotCanonical.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  PROFILE_ARTICLES_QUERY_KEY,
  profileContentRevalidating,
} from "~/lib/profileContentQueries.ts";
import type { articlesPageQuery } from "./__generated__/articlesPageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

const articlesPageQuery = graphql`
  query articlesPageQuery($handle: String!, $locale: Locale!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      rawName
      username
      viewerBlocks
      blocksViewer
      ...NavigateIfHandleIsNotCanonical_actor
      ...ActorArticleList_articles @arguments(locale: $locale)
      ...ProfileCard_actor
      ...ProfileTabs_actor
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (handle: string, locale: string) =>
    loadQuery<articlesPageQuery>(
      useRelayEnvironment()(),
      articlesPageQuery,
      { handle, locale },
      { fetchPolicy: "store-and-network" },
    ),
  PROFILE_ARTICLES_QUERY_KEY,
);

export default function ProfileArticlesPage() {
  const params = useParams();
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<articlesPageQuery>(
    articlesPageQuery,
    () => loadPageQuery(params.handle!, i18n.locale),
  );
  return (
    <Show keyed when={data()}>
      {(data) => (
        <>
          {
            /*
            `keyed` prevents a "Stale read from <Show>" race: when
            solid-relay's fragment subscription publishes a new snapshot
            inside `batch()`, a non-keyed `<Show>{(actor) => ...}` accessor
            can throw if `actorByHandle` flips to falsy in the same tick
            that an inner reactive computation re-runs. Reconcile keeps the
            actor's identity stable (`key: "__id"`), so `keyed` only
            re-mounts when navigating to a different actor.
          */
          }
          <Show
            keyed
            when={data.actorByHandle}
            fallback={<NotFoundPage fullscreen />}
          >
            {(actor) => (
              <NarrowContainer>
                <Title>
                  {t`${actor.rawName ?? actor.username}'s articles`}
                </Title>
                <Meta
                  property="og:title"
                  content={t`${actor.rawName ?? actor.username}'s articles`}
                />
                <NavigateIfHandleIsNotCanonical $actor={actor} />
                <div>
                  <ProfileCard $actor={actor} />
                </div>
                <Show
                  when={!actor.viewerBlocks && !actor.blocksViewer &&
                    !profileContentRevalidating()}
                >
                  <div class="p-4">
                    <ProfileTabs selected="articles" $actor={actor} />
                    <ActorArticleList $articles={actor} />
                  </div>
                </Show>
              </NarrowContainer>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
