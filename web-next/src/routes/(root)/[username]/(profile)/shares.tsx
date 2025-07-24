import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorSharedPostList } from "~/components/ActorSharedPostList.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { sharesPageQuery } from "./__generated__/sharesPageQuery.graphql.ts";

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

const sharesPageQuery = graphql`
  query sharesPageQuery($username: String!, $locale: Locale!) {
    accountByUsername(username: $username) {
      username
      actor {
        ...ActorSharedPostList_sharedPosts @arguments(locale: $locale)
        ...ProfileTabs_actor
      }
      ...ProfilePageBreadcrumb_account
      ...ProfileCard_account
    }
  }
`;

const loadPageQuery = query(
  (username: string, locale: string) =>
    loadQuery<sharesPageQuery>(
      useRelayEnvironment()(),
      sharesPageQuery,
      { username, locale },
    ),
  "loadSharesPageQuery",
);

export default function ProfileSharesPage() {
  const params = useParams();
  const { t, i18n } = useLingui();
  const username = params.username.substring(1);
  const data = createPreloadedQuery<sharesPageQuery>(
    sharesPageQuery,
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
                      {t`Shares`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div>
                  <ProfileCard $account={account()} />
                </div>
                <div class="p-4">
                  <ProfileTabs selected="shares" $actor={account().actor} />
                  <ActorSharedPostList $sharedPosts={account().actor} />
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
