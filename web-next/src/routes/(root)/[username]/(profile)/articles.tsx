import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorArticleList } from "~/components/ActorArticleList.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { articlesPageQuery } from "./__generated__/articlesPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    username: /^\@/,
  },
  preload(args) {
    const { i18n } = useLingui();
    const username = args.params.username;
    void loadPageQuery(username.substring(1), i18n.locale);
  },
} satisfies RouteDefinition;

const articlesPageQuery = graphql`
  query articlesPageQuery(
    $username: String!
    $locale: Locale!
  ) {
    accountByUsername(username: $username) {
      username
      actor {
        ...ActorArticleList_articles @arguments(locale: $locale)
        ...ProfileTabs_actor
      }
      ...ProfilePageBreadcrumb_account
      ...ProfileCard_account
    }
  }
`;

const loadPageQuery = query(
  (username: string, locale: string) =>
    loadQuery<articlesPageQuery>(
      useRelayEnvironment()(),
      articlesPageQuery,
      { username, locale },
    ),
  "loadArticlesPageQuery",
);

export default function ProfileArticlesPage() {
  const params = useParams();
  const { t, i18n } = useLingui();
  const username = params.username.substring(1);
  const data = createPreloadedQuery<articlesPageQuery>(
    articlesPageQuery,
    () => loadPageQuery(username, i18n.locale),
  );
  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show
            when={data().accountByUsername}
          >
            {(account) => (
              <>
                <ProfilePageBreadcrumb $account={account()}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink current>
                      {t`Articles`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div>
                  <ProfileCard $account={account()} />
                </div>
                <div class="p-4">
                  <ProfileTabs selected="articles" $actor={account().actor} />
                  <ActorArticleList $articles={account().actor} />
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
