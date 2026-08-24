import { graphql } from "relay-runtime";
import { Show, untrack } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { AboutHackersPub } from "~/components/AboutHackersPub.tsx";
import { FollowRecommendations } from "~/components/FollowRecommendations.tsx";
import { LanguageFilter } from "~/components/LanguageFilter.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { PublicTimeline } from "~/components/PublicTimeline.tsx";
import { TimelineNoteComposer } from "~/components/TimelineNoteComposer.tsx";
import { Title } from "~/components/Title.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import {
  getTimelinePageQueryLoadOptions,
  TIMELINE_PAGE_QUERY_CACHE_KEYS,
} from "~/lib/timelinePageQueryCache.ts";
import { useLanguageFilter } from "~/lib/useLanguageFilter.ts";
import type { localTimelineQuery } from "./__generated__/localTimelineQuery.graphql.ts";

const localTimelineQuery = graphql`
  query localTimelineQuery(
    $actingAccountId: ID
    $locale: Locale
    $languages: [Locale!]
  ) {
    viewer {
      actor {
        followees(first: 0) {
          totalCount
        }
      }
      postCount
    }
    suggestedFilterLanguages
    ...PublicTimeline_posts
      @arguments(
        actingAccountId: $actingAccountId
        locale: $locale
        languages: $languages
        local: true
        withoutShares: false
        postType: null
      )
  }
`;

const loadLocalTimelineQuery = routePreloadedQuery(
  (
    locale: string,
    languages: readonly string[],
    actingAccountId: string | null,
  ) =>
    loadQuery<localTimelineQuery>(
      useRelayEnvironment()(),
      localTimelineQuery,
      {
        actingAccountId,
        locale,
        languages,
      },
      getTimelinePageQueryLoadOptions(TIMELINE_PAGE_QUERY_CACHE_KEYS.local),
    ),
  TIMELINE_PAGE_QUERY_CACHE_KEYS.local,
);

export default function LocalTimeline() {
  const { i18n, t } = useLingui();
  const actingAccount = useActingAccount();
  const { activeLanguage, initialLang, buildHref } =
    useLanguageFilter("/local");
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const initialActingAccountId = untrack(actingAccountId) ?? null;
  const data = createStablePreloadedQuery<localTimelineQuery>(
    localTimelineQuery,
    () =>
      loadLocalTimelineQuery(
        i18n.locale,
        initialLang ? [initialLang] : [],
        initialActingAccountId,
      ),
  );

  return (
    <>
      <Title>{t`Hackers' Pub: Local timeline`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <NarrowContainer>
            <Show when={data.viewer == null}>
              <AboutHackersPub />
            </Show>
            <Show keyed when={data.viewer}>
              {(viewer) => (
                <>
                  <TimelineNoteComposer />
                  <FollowRecommendations
                    followeesCount={viewer.actor.followees.totalCount}
                    postCount={viewer.postCount}
                  />
                </>
              )}
            </Show>
            <Show
              when={
                (data.suggestedFilterLanguages?.length ?? 0) > 0 ||
                !!activeLanguage()
              }
            >
              <LanguageFilter
                languages={data.suggestedFilterLanguages ?? []}
                activeLanguage={activeLanguage()}
                buildHref={buildHref}
              />
            </Show>
            <PublicTimeline
              $posts={data}
              activeLanguage={activeLanguage}
              initialActingAccountId={initialActingAccountId}
              initialLanguage={initialLang}
              local
            />
          </NarrowContainer>
        )}
      </Show>
    </>
  );
}
