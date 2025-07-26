import { Meta } from "@solidjs/meta";
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
import { Title } from "~/components/Title.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
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
        ...ProfilePageBreadcrumb_actor
        ...ProfileCard_actor
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
                <ProfilePageBreadcrumb $actor={account().actor}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink current>
                      {t`Followers`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div>
                  <ProfileCard $actor={account().actor} />
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
