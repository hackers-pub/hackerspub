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
import { ADMIN_SORT_FIELDS } from "~/lib/adminSort.ts";

const adminAccountsPageQuery = graphql`
  query adminAccountsPageQuery(
    $count: Int!
    $cursor: String
    $orderBy: AdminAccountOrderBy
    $orderDirection: OrderDirection
    $search: String
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
        search: $search
      )
  }
`;

function parseQueryParams(search: string): {
  orderBy: AdminAccountOrderBy;
  orderDirection: OrderDirection;
  search: string | undefined;
} {
  const params = new URLSearchParams(search);
  const rawSort = params.get("sort")?.toUpperCase() ?? "";
  const orderBy: AdminAccountOrderBy = ADMIN_SORT_FIELDS.has(rawSort)
    ? (rawSort as AdminAccountOrderBy)
    : "LAST_ACTIVITY";
  const rawDir = params.get("dir")?.toUpperCase() ?? "";
  const orderDirection: OrderDirection = rawDir === "ASC" || rawDir === "DESC"
    ? rawDir
    : "DESC";
  const q = params.get("q") ?? undefined;
  return { orderBy, orderDirection, search: q };
}

const loadAdminAccountsPageQuery = routePreloadedQuery(
  (
    orderBy: AdminAccountOrderBy,
    orderDirection: OrderDirection,
    search: string | undefined,
  ) =>
    loadQuery<adminAccountsPageQuery>(
      useRelayEnvironment()(),
      adminAccountsPageQuery,
      { count: 100, orderBy, orderDirection, search },
    ),
  "loadAdminAccountsPageQuery",
);

export default function AdminAccountsPage() {
  const { t } = useLingui();
  const location = useLocation();
  const queryParams = () => parseQueryParams(location.search);
  const data = createPreloadedQuery<adminAccountsPageQuery>(
    adminAccountsPageQuery,
    () => {
      const { orderBy, orderDirection, search } = queryParams();
      return loadAdminAccountsPageQuery(orderBy, orderDirection, search);
    },
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
