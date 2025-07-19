import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import type { ProfilePageQuery } from "./__generated__/ProfilePageQuery.graphql.ts";

export const route = {
  matchFilters: {
    username: /^\@/,
  },
  preload(args) {
    const username = args.params.username;
    void loadPageQuery(username.substring(1));
  },
} satisfies RouteDefinition;

const ProfilePageQuery = graphql`
  query ProfilePageQuery($username: String!) {
    accountByUsername(username: $username) {
      ...ProfilePageBreadcrumb_account
      ...ProfileCard_account
    }
  }
`;

const loadPageQuery = query(
  (username: string) =>
    loadQuery<ProfilePageQuery>(
      useRelayEnvironment()(),
      ProfilePageQuery,
      {
        username,
      },
    ),
  "loadProfilePageQuery",
);

export default function ProfilePage() {
  const params = useParams();
  const username = params.username.substring(1);
  const data = createPreloadedQuery<ProfilePageQuery>(
    ProfilePageQuery,
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
                <ProfilePageBreadcrumb $account={account()} />
                <div>
                  <ProfileCard $account={account()} />
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
