import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { AdminAccountsTable } from "~/components/admin/AdminAccountsTable.tsx";
import { Title } from "~/components/Title.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { adminAccountsPageQuery } from "./__generated__/adminAccountsPageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

const adminAccountsPageQuery = graphql`
  query adminAccountsPageQuery($count: Int!, $cursor: String) {
    viewer {
      moderator
    }
    ...AdminAccountsTable_query @arguments(count: $count, cursor: $cursor)
  }
`;

const loadAdminAccountsPageQuery = routePreloadedQuery(
  () =>
    loadQuery<adminAccountsPageQuery>(
      useRelayEnvironment()(),
      adminAccountsPageQuery,
      { count: 100 },
    ),
  "loadAdminAccountsPageQuery",
);

export const route = {
  preload() {
    void loadAdminAccountsPageQuery();
  },
};

export default function AdminAccountsPage() {
  const { t } = useLingui();
  const data = createPreloadedQuery<adminAccountsPageQuery>(
    adminAccountsPageQuery,
    () => loadAdminAccountsPageQuery(),
  );
  return (
    <WideContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Accounts`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            when={data.viewer?.moderator}
            fallback={<Navigate href="/sign?next=%2Fadmin" />}
          >
            <h1 class="mb-4 text-2xl font-semibold tracking-tight">
              {t`Accounts`}
            </h1>
            <AdminAccountsTable $query={data} />
          </Show>
        )}
      </Show>
    </WideContainer>
  );
}
