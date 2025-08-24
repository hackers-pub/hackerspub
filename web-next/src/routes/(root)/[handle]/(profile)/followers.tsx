import { Meta, Title } from "@solidjs/meta";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorFollowerList } from "~/components/ActorFollowerList.tsx";
import { ProfilePageBreadcrumbItem } from "~/components/ProfilePageBreadcrumb.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { followersPageQuery } from "./__generated__/followersPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    const username = args.params.handle;
    void loadPageQuery(username.substring(1));
  },
} satisfies RouteDefinition;

const followersPageQuery = graphql`
  query followersPageQuery($username: String!) {
    accountByUsername(username: $username) {
      name
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
  const username = params.handle.substring(1);
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
                <Title>{t`${account().name}'s followers`}</Title>
                <Meta
                  property="og:title"
                  content={t`${account().name}'s followers`}
                />
                <ProfilePageBreadcrumbItem breadcrumb={t`Followers`} />
                <ActorFollowerList $followers={account().actor} />
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
