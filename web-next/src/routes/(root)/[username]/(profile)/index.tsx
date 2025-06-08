import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ProfileCard } from "~/components/ProfileCard.tsx";
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
        <div>
          <Show
            when={data().accountByUsername}
            fallback={<div>Not Found: {username}</div>}
          >
            {(account) => (
              <>
                <ProfileCard $account={account()} />
              </>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
