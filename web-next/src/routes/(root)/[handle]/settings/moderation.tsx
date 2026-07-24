import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { ReportHistoryList } from "~/components/ReportHistoryList.tsx";
import { SanctionHistoryList } from "~/components/SanctionHistoryList.tsx";
import { SettingsContainer } from "~/components/SettingsContainer.tsx";
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
import { useLingui } from "~/lib/i18n/macro.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { moderationPageQuery } from "./__generated__/moderationPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const moderationPageQuery = graphql`
  query moderationPageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      ...SettingsTabs_account
      ...ReportHistoryList_account
      sanctions {
        uuid
        actionType
        violatedProvisions
        messageToUser
        suspensionEnds
        created
        appealableUntil
        appeal {
          status
          result
          reviewRationale
          resolved
        }
      }
    }
  }
`;

const loadModerationPageQuery = routePreloadedQuery(
  (handle: string, _version: number) =>
    loadQuery<moderationPageQuery>(
      useRelayEnvironment()(),
      moderationPageQuery,
      { username: handle.replace(/^@/, "") },
      { fetchPolicy: "network-only" },
    ),
  "loadModerationPageQuery",
);

export default function ModerationPage() {
  const params = useParams();
  const { t } = useLingui();
  const [version, setVersion] = createSignal(0);

  const data = createStablePreloadedQuery<moderationPageQuery>(
    moderationPageQuery,
    () => loadModerationPageQuery(decodeRouteParam(params.handle!), version()),
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
                <Title>{t`Moderation`}</Title>
                <SettingsContainer class="p-4">
                  <SettingsTabs selected="moderation" $account={account} />
                  <div class="mt-4 flex flex-col gap-4">
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Report history`}</CardTitle>
                        <CardDescription>
                          {t`Reports you have filed, newest first. You can see the target, your reason, and the current status. Detailed outcomes are not shown, and the reported user never learns who reported them.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent class="px-0">
                        <ReportHistoryList $account={account} />
                      </CardContent>
                    </Card>
                    <Card>
                      <CardHeader>
                        <CardTitle>{t`Moderation actions`}</CardTitle>
                        <CardDescription>
                          {t`Decisions the moderation team has made about your account or posts, newest first. You can appeal a decision once, within 14 days.`}
                        </CardDescription>
                      </CardHeader>
                      <CardContent class="px-0">
                        <SanctionHistoryList
                          sanctions={account.sanctions}
                          onAppealSuccess={() => setVersion((v) => v + 1)}
                        />
                      </CardContent>
                    </Card>
                  </div>
                </SettingsContainer>
              </>
            )}
          </Show>
        </SettingsOwnerGuard>
      )}
    </Show>
  );
}
