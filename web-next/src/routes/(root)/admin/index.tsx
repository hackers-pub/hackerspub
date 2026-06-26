import { Navigate, useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { AdminAccountsTable } from "~/components/admin/AdminAccountsTable.tsx";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type {
  AccountKind,
  AdminAccountOrderBy,
  adminAccountsPageQuery,
  OrderDirection,
} from "./__generated__/adminAccountsPageQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { ADMIN_SORT_FIELDS } from "~/lib/adminSort.ts";

const adminAccountsPageQuery = graphql`
  query adminAccountsPageQuery(
    $count: Int!
    $cursor: String
    $orderBy: AdminAccountOrderBy
    $orderDirection: OrderDirection
    $kind: AccountKind
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
        kind: $kind
        search: $search
      )
  }
`;

function parseQueryParams(search: string): {
  orderBy: AdminAccountOrderBy;
  orderDirection: OrderDirection;
  kind: AccountKind | undefined;
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
  const rawKind = params.get("kind");
  const kind: AccountKind | undefined = rawKind === "personal"
    ? "PERSONAL"
    : rawKind === "organization"
    ? "ORGANIZATION"
    : undefined;
  const q = params.get("q") ?? undefined;
  return { orderBy, orderDirection, kind, search: q };
}

const loadAdminAccountsPageQuery = routePreloadedQuery(
  (
    orderBy: AdminAccountOrderBy,
    orderDirection: OrderDirection,
    kind: AccountKind | undefined,
    search: string | undefined,
  ) =>
    loadQuery<adminAccountsPageQuery>(
      useRelayEnvironment()(),
      adminAccountsPageQuery,
      { count: 100, orderBy, orderDirection, kind, search },
    ),
  "loadAdminAccountsPageQuery",
);

export default function AdminAccountsPage() {
  const { t } = useLingui();
  const location = useLocation();
  const queryParams = () => parseQueryParams(location.search);
  const data = createStablePreloadedQuery<adminAccountsPageQuery>(
    adminAccountsPageQuery,
    () => {
      const { orderBy, orderDirection, kind, search } = queryParams();
      return loadAdminAccountsPageQuery(
        orderBy,
        orderDirection,
        kind,
        search,
      );
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
            <AdminTabs selected="accounts" />
            <h1 class="mb-4 mt-4 text-2xl font-semibold tracking-tight">
              {t`Accounts`}
            </h1>
            <AdminAccountsTable $query={data} />
          </Show>
        )}
      </Show>
    </WideContainer>
  );
}
