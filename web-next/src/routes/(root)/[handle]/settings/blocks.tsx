import { type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import type { blocksPageQuery } from "./__generated__/blocksPageQuery.graphql.ts";
import { BlockedAccountsList } from "~/components/BlockedAccountsList.tsx";
import { MutedAccountsList } from "~/components/MutedAccountsList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { SettingsOwnerGuard } from "~/components/SettingsOwnerGuard.tsx";
import { SettingsTabs } from "~/components/SettingsTabs.tsx";
import { Title } from "~/components/Title.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const blocksPageQuery = graphql`
  query blocksPageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      ...SettingsTabs_account
      actor {
        ...MutedAccountsList_actor
        ...BlockedAccountsList_actor
      }
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<blocksPageQuery>(
      useRelayEnvironment()(),
      blocksPageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadBlocksPageQuery",
);

export default function BlocksPage() {
  const params = useParams();
  const { t } = useLingui();

  const data = createStablePreloadedQuery<blocksPageQuery>(
    blocksPageQuery,
    () => loadPageQuery(decodeRouteParam(params.handle!)),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <SettingsOwnerGuard
          accountId={data.accountByUsername?.id}
          viewerId={data.viewer?.id}
        >
          <Show keyed when={data.accountByUsername}>
            {(account) => (
              <>
                <Title>{t`Mutes and blocks`}</Title>
                <NarrowContainer class="p-4">
                  <SettingsTabs selected="blocks" $account={account} />

                  <div class="mt-4 space-y-6">
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Muted accounts`}</CardTitle>
                        <CardDescription>
                          {t`Muted accounts are hidden from your feeds and stop notifying you, except for replies and mentions from accounts you follow. You can still visit their profiles, and muting is private and never federated.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent class="px-0">
                        <Show keyed when={account.actor}>
                          {(actor) => <MutedAccountsList $actor={actor} />}
                        </Show>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Blocked accounts`}</CardTitle>
                        <CardDescription>
                          {t`Blocked accounts cannot follow you or see your posts. Unlike muting, blocking is federated to the blocked account's instance.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent class="px-0">
                        <Show keyed when={account.actor}>
                          {(actor) => <BlockedAccountsList $actor={actor} />}
                        </Show>
                      </CardContent>
                    </Card>
                  </div>
                </NarrowContainer>
              </>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}
