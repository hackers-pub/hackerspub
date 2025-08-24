import { Meta } from "@solidjs/meta";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorArticleList } from "~/components/ActorArticleList.tsx";
import { ProfilePageBreadcrumbItem } from "~/components/ProfilePageBreadcrumb.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { articlesPageQuery } from "./__generated__/articlesPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const { i18n } = useLingui();
    void loadPageQuery(args.params.handle, i18n.locale);
  },
} satisfies RouteDefinition;

const articlesPageQuery = graphql`
  query articlesPageQuery($handle: String!, $locale: Locale!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      rawName
      username
      ...ActorArticleList_articles @arguments(locale: $locale)
      ...ProfileTabs_actor
    }
  }
`;

const loadPageQuery = query(
  (handle: string, locale: string) =>
    loadQuery<articlesPageQuery>(
      useRelayEnvironment()(),
      articlesPageQuery,
      { handle, locale },
    ),
  "loadArticlesPageQuery",
);

export default function ProfileArticlesPage() {
  const params = useParams();
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<articlesPageQuery>(
    articlesPageQuery,
    () => loadPageQuery(params.handle, i18n.locale),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show when={data().actorByHandle}>
            {(actor) => (
              <>
                <Title>
                  {t`${actor().rawName ?? actor().username}'s articles`}
                </Title>
                <Meta
                  property="og:title"
                  content={t`${actor().rawName ?? actor().username}'s articles`}
                />
                <ProfilePageBreadcrumbItem breadcrumb={t`Articles`} />
                <ProfileTabs selected="articles" $actor={actor()} />
                <ActorArticleList $articles={actor()} />
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
