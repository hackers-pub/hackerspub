import { Navigate, useLocation } from "@solidjs/router";
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
import type {
  AdminAccountOrderBy,
  adminAccountsPageQuery,
  OrderDirection,
} from "./__generated__/adminAccountsPageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

const adminAccountsPageQuery = graphql`
  query adminAccountsPageQuery(
    $count: Int!
    $cursor: String
    $orderBy: AdminAccountOrderBy
    $orderDirection: OrderDirection
  ) {
    viewer {
      moderator
    }
    ...AdminAccountsTable_query
      @arguments(
        count: $count
        cursor: $cursor
        orderBy: $orderBy
        orderDirection: $orderDirection
      )
  }
`;

function parseSortParams(search: string): {
  orderBy: AdminAccountOrderBy;
  orderDirection: OrderDirection;
} {
  const params = new URLSearchParams(search);
  const orderBy =
    (params.get("sort")?.toUpperCase() as AdminAccountOrderBy | null) ??
      "LAST_ACTIVITY";
  const orderDirection =
    (params.get("dir")?.toUpperCase() as OrderDirection | null) ?? "DESC";
  return { orderBy, orderDirection };
}

const loadAdminAccountsPageQuery = routePreloadedQuery(
  (orderBy: AdminAccountOrderBy, orderDirection: OrderDirection) =>
    loadQuery<adminAccountsPageQuery>(
      useRelayEnvironment()(),
      adminAccountsPageQuery,
      { count: 100, orderBy, orderDirection },
    ),
  "loadAdminAccountsPageQuery",
);

export const route = {
  preload({ location }: { location: { search: string } }) {
    const { orderBy, orderDirection } = parseSortParams(location.search);
    void loadAdminAccountsPageQuery(orderBy, orderDirection);
  },
};

export default function AdminAccountsPage() {
  const { t } = useLingui();
  const location = useLocation();
  const sortParams = () => parseSortParams(location.search);
  const data = createPreloadedQuery<adminAccountsPageQuery>(
    adminAccountsPageQuery,
    () =>
      loadAdminAccountsPageQuery(
        sortParams().orderBy,
        sortParams().orderDirection,
      ),
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
