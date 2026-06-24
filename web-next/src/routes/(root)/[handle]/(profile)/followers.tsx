import { Meta } from "@solidjs/meta";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { ActorFollowerList } from "~/components/ActorFollowerList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { Title } from "~/components/Title.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { followersPageQuery } from "./__generated__/followersPageQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const followersPageQuery = graphql`
  query followersPageQuery($username: String!, $actingAccountId: ID) {
    accountByUsername(username: $username) {
      name
      username
      actor {
        ...ProfileCard_actor @arguments(actingAccountId: $actingAccountId)
        ...ActorFollowerList_followers @arguments(
          actingAccountId: $actingAccountId
        )
      }
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (username: string, actingAccountId: string | null) =>
    loadQuery<followersPageQuery>(
      useRelayEnvironment()(),
      followersPageQuery,
      { username, actingAccountId },
    ),
  "loadFollowersPageQuery",
);

export default function ProfileFollowersPage() {
  const params = useParams();
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const username = decodeRouteParam(params.handle!).substring(1);
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<followersPageQuery>(
    followersPageQuery,
    () => loadPageQuery(username, actingAccountId() ?? null),
  );
  return (
    <Show keyed when={data()}>
      {(data) => (
        <>
          {
            /*
            `keyed` prevents a "Stale read from <Show>" race: when
            solid-relay's fragment subscription publishes a new snapshot
            inside `batch()`, a non-keyed `<Show>{(account) => ...}`
            accessor can throw if `accountByUsername` flips to falsy in the
            same tick that an inner reactive computation re-runs. Reconcile
            keeps the account's identity stable (`key: "__id"`), so `keyed`
            only re-mounts when navigating to a different account.
          */
          }
          <Show
            keyed
            when={data.accountByUsername}
            fallback={<NotFoundPage fullscreen />}
          >
            {(account) => (
              <NarrowContainer>
                <Title>{t`${account.name}'s followers`}</Title>
                <Meta
                  property="og:title"
                  content={t`${account.name}'s followers`}
                />
                <div>
                  <ProfileCard $actor={account.actor} />
                </div>
                <div class="p-4">
                  <ActorFollowerList $followers={account.actor} />
                </div>
              </NarrowContainer>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
