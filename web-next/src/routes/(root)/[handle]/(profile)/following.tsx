import { Meta } from "@solidjs/meta";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorFollowingList } from "~/components/ActorFollowingList.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { followingPageQuery } from "./__generated__/followingPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload(args) {
    const username = args.params.handle!;
    void loadPageQuery(username.substring(1));
  },
} satisfies RouteDefinition;

const followingPageQuery = graphql`
  query followingPageQuery($username: String!) {
    accountByUsername(username: $username) {
      name
      username
      actor {
        ...ProfileCard_actor
        ...ActorFollowingList_following
      }
    }
  }
`;

const loadPageQuery = query(
  (username: string) =>
    loadQuery<followingPageQuery>(
      useRelayEnvironment()(),
      followingPageQuery,
      { username },
    ),
  "loadFollowingPageQuery",
);

export default function ProfileFollowingPage() {
  const params = useParams();
  const { t } = useLingui();
  const username = params.handle!.substring(1);
  const data = createPreloadedQuery<followingPageQuery>(
    followingPageQuery,
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
                <Title>{t`${account().name}'s following`}</Title>
                <Meta
                  property="og:title"
                  content={t`${account().name}'s following`}
                />
                <div>
                  <ProfileCard $actor={account().actor} />
                </div>
                <div class="p-4">
                  <ActorFollowingList $following={account().actor} />
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
