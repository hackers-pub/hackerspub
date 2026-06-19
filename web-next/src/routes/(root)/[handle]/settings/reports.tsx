import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { SettingsContainer } from "~/components/SettingsContainer.tsx";
import { ReportHistoryList } from "~/components/ReportHistoryList.tsx";
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
import { decodeRouteParam } from "~/lib/routeParam.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { reportsPageQuery } from "./__generated__/reportsPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
} satisfies RouteDefinition;

const reportsPageQuery = graphql`
  query reportsPageQuery($username: String!) {
    viewer {
      id
    }
    accountByUsername(username: $username) {
      id
      username
      ...SettingsTabs_account
      ...ReportHistoryList_account
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<reportsPageQuery>(
      useRelayEnvironment()(),
      reportsPageQuery,
      { username: handle.replace(/^@/, "") },
    ),
  "loadReportsPageQuery",
);

export default function ReportsPage() {
  const params = useParams();
  const { t } = useLingui();

  const data = createStablePreloadedQuery<reportsPageQuery>(
    reportsPageQuery,
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
                <Title>{t`Report history`}</Title>
                <SettingsContainer class="p-4">
                  <SettingsTabs selected="reports" $account={account} />

                  <div class="mt-4">
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
