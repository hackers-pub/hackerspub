import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorPostList } from "~/components/ActorPostList.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ProfilePageQuery } from "./__generated__/ProfilePageQuery.graphql.ts";

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

const ProfilePageQuery = graphql`
  query ProfilePageQuery($username: String!, $locale: Locale) {
    accountByUsername(username: $username) {
      username
      actor {
        ...ActorPostList_posts @arguments(locale: $locale)
        ...ProfileTabs_actor
      }
      ...ProfilePageBreadcrumb_account
      ...ProfileCard_account
    }
  }
`;

const loadPageQuery = query(
  (username: string, locale: string) =>
    loadQuery<ProfilePageQuery>(
      useRelayEnvironment()(),
      ProfilePageQuery,
      { username, locale },
    ),
  "loadProfilePageQuery",
);

export default function ProfilePage() {
  const { i18n } = useLingui();
  const params = useParams();
  const username = params.username.substring(1);
  const data = createPreloadedQuery<ProfilePageQuery>(
    ProfilePageQuery,
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
                <ProfilePageBreadcrumb $account={account()} />
                <div>
                  <ProfileCard $account={account()} />
                </div>
                <div class="p-4">
                  <ProfileTabs selected="posts" $actor={account().actor} />
                  <ActorPostList $posts={account().actor} />
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
