import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorFollowerList } from "~/components/ActorFollowerList.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { followersPageQuery } from "./__generated__/followersPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    username: /^\@/,
  },
  preload(args) {
    const username = args.params.username;
    void loadPageQuery(username.substring(1));
  },
} satisfies RouteDefinition;

const followersPageQuery = graphql`
  query followersPageQuery($username: String!) {
    accountByUsername(username: $username) {
      ...ProfileCard_account
      ...ProfilePageBreadcrumb_account
      username
      actor {
        ...ActorFollowerList_followers
      }
    }
  }
`;

const loadPageQuery = query(
  (username: string) =>
    loadQuery<followersPageQuery>(
      useRelayEnvironment()(),
      followersPageQuery,
      { username },
    ),
  "loadFollowersPageQuery",
);

export default function ProfileFollowersPage() {
  const params = useParams();
  const { t } = useLingui();
  const username = params.username.substring(1);
  const data = createPreloadedQuery<followersPageQuery>(
    followersPageQuery,
    () => loadPageQuery(username),
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
                      {t`Followers`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div>
                  <ProfileCard $account={account()} />
                </div>
                <div class="p-4">
                  <ActorFollowerList $followers={account().actor} />
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
