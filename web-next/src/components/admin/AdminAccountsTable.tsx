import { A, useLocation, useNavigate } from "@solidjs/router";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconChevronUp from "~icons/lucide/chevron-up";
import IconChevronsUpDown from "~icons/lucide/chevrons-up-down";
import IconSearch from "~icons/lucide/search";
import IconX from "~icons/lucide/x";
import { graphql } from "relay-runtime";
import { ADMIN_SORT_FIELDS } from "~/lib/adminSort.ts";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { AdminAccountsTable_query$key } from "./__generated__/AdminAccountsTable_query.graphql.ts";

export interface AdminAccountsTableProps {
  $query: AdminAccountsTable_query$key;
}

type AccountKindFilter = "all" | "personal" | "organization";

const ACCOUNT_KIND_FILTERS: AccountKindFilter[] = [
  "all",
  "personal",
  "organization",
];

export function AdminAccountsTable(props: AdminAccountsTableProps) {
  const { i18n, t } = useLingui();
  const location = useLocation();
  const navigate = useNavigate();

  // Parse once per URL change so all three derived signals share the object.
  const searchParams = createMemo(() => new URLSearchParams(location.search));

  const currentSort = () => {
    const raw = searchParams().get("sort")?.toUpperCase() ?? "";
    return ADMIN_SORT_FIELDS.has(raw) ? raw : "LAST_ACTIVITY";
  };
  const currentDir = () => {
    const raw = searchParams().get("dir")?.toUpperCase() ?? "";
    return raw === "ASC" || raw === "DESC" ? raw : "DESC";
  };
  const currentSearch = () => searchParams().get("q") ?? "";
  const currentKind = (): AccountKindFilter => {
    const raw = searchParams().get("kind");
    return raw === "personal" || raw === "organization" ? raw : "all";
  };

  // Sync the text input with the URL whenever the URL's ?q param changes
  // (e.g. after navigating via a sort-column link).
  const [searchInput, setSearchInput] = createSignal(currentSearch());
  createEffect(() => setSearchInput(currentSearch()));

  function sortHref(field: string): string {
    const params = new URLSearchParams(location.search);
    if (currentSort() === field) {
      params.set("dir", currentDir() === "DESC" ? "ASC" : "DESC");
    } else {
      params.set("sort", field);
      params.delete("dir");
    }
    return `${location.pathname}?${params.toString()}`;
  }

  function searchHref(q: string): string {
    const params = new URLSearchParams(location.search);
    if (q.trim()) {
      params.set("q", q.trim());
    } else {
      params.delete("q");
    }
    return `${location.pathname}?${params.toString()}`;
  }

  function kindHref(kind: AccountKindFilter): string {
    const params = new URLSearchParams(location.search);
    if (kind === "all") {
      params.delete("kind");
    } else {
      params.set("kind", kind);
    }
    return `${location.pathname}?${params.toString()}`;
  }

  function onSearchSubmit(e: SubmitEvent) {
    e.preventDefault();
    navigate(searchHref(searchInput()));
  }

  function SortIcon(props: { field: string }) {
    return (
      <span class="ml-1 inline-flex size-3 shrink-0 items-center">
        <Show
          when={currentSort() === props.field}
          fallback={
            <IconChevronsUpDown class="size-3 text-muted-foreground/50" />
          }
        >
          <Show
            when={currentDir() === "ASC"}
            fallback={<IconChevronDown class="size-3" />}
          >
            <IconChevronUp class="size-3" />
          </Show>
        </Show>
      </span>
    );
  }

  function accountKindLabel(kind: AccountKindFilter) {
    switch (kind) {
      case "personal":
        return t`Personal accounts`;
      case "organization":
        return t`Organization accounts`;
      case "all":
        return t`All accounts`;
    }
  }

  const data = createPaginationFragment(
    graphql`
      fragment AdminAccountsTable_query on Query
        @refetchable(queryName: "AdminAccountsTablePaginationQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 100 }
          orderBy: { type: "AdminAccountOrderBy" }
          orderDirection: { type: "OrderDirection" }
          kind: { type: "AccountKind" }
          search: { type: "String" }
        )
      {
        adminAccounts(
          after: $cursor
          first: $count
          orderBy: $orderBy
          orderDirection: $orderDirection
          kind: $kind
          search: $search
        )
          @connection(
            key: "AdminAccountsTable_adminAccounts"
            filters: ["orderBy", "orderDirection", "kind", "search"]
          )
        {
          totalCount
          edges {
            lastActivity
            node {
              id
              uuid
              username
              name
              handle
              avatarUrl
              invitationsLeft
              postCount
              created
              actor {
                followers(first: 0) {
                  totalCount
                }
                followees(first: 0) {
                  totalCount
                }
              }
              inviter {
                username
                name
                handle
                avatarUrl
              }
              invitees(first: 0) {
                totalCount
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$query,
  );

  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    data.loadNext(100, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  const formatNumber = (n: number) => n.toLocaleString(i18n.locale);

  return (
    <Show keyed when={data()?.adminAccounts}>
      {(conn) => (
        <>
          <form
            onSubmit={onSearchSubmit}
            class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end"
          >
            <div class="relative flex-1">
              <label for="admin-account-search" class="sr-only">
                {t`Search accounts`}
              </label>
              <IconSearch class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="admin-account-search"
                type="search"
                value={searchInput()}
                onInput={(e) => setSearchInput(e.currentTarget.value)}
                placeholder={t`Search by name or username…`}
                class="h-10 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
            </div>
            <div class="flex flex-wrap gap-2 sm:flex-nowrap">
              <Select
                class="grid min-w-48 gap-1.5"
                value={currentKind()}
                onChange={(kind) => kind != null && navigate(kindHref(kind))}
                options={ACCOUNT_KIND_FILTERS}
                itemComponent={(props) => (
                  <SelectItem item={props.item}>
                    {accountKindLabel(props.item.rawValue)}
                  </SelectItem>
                )}
              >
                <SelectLabel class="sr-only">{t`Account kind`}</SelectLabel>
                <SelectTrigger class="h-10">
                  <SelectValue<AccountKindFilter>>
                    {(state) => accountKindLabel(state.selectedOption())}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent />
              </Select>
              <Button type="submit" variant="outline" size="sm" class="h-10">
                {t`Search`}
              </Button>
              <Show when={currentSearch()}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="h-10 gap-1"
                  onClick={() => navigate(searchHref(""))}
                >
                  <IconX class="size-3" />
                  {t`Clear`}
                </Button>
              </Show>
            </div>
          </form>
          <p class="mb-4 text-sm text-muted-foreground">
            {t`Total: ${formatNumber(conn.totalCount)}`}
          </p>
          <div class="rounded-lg border bg-card shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t`Account`}</TableHead>
                  <TableHead class="text-right">
                    <A
                      href={sortHref("FOLLOWING")}
                      class="inline-flex items-center justify-end hover:text-foreground transition-colors"
                    >
                      {t`Following`}
                      <SortIcon field="FOLLOWING" />
                    </A>
                  </TableHead>
                  <TableHead class="text-right">
                    <A
                      href={sortHref("FOLLOWERS")}
                      class="inline-flex items-center justify-end hover:text-foreground transition-colors"
                    >
                      {t`Followers`}
                      <SortIcon field="FOLLOWERS" />
                    </A>
                  </TableHead>
                  <TableHead class="text-right">
                    <A
                      href={sortHref("POSTS")}
                      class="inline-flex items-center justify-end hover:text-foreground transition-colors"
                    >
                      {t`Posts`}
                      <SortIcon field="POSTS" />
                    </A>
                  </TableHead>
                  <TableHead class="text-right whitespace-nowrap">
                    <A
                      href={sortHref("INVITATIONS_LEFT")}
                      class="inline-flex items-center justify-end hover:text-foreground transition-colors"
                    >
                      {t`Invitations left`}
                      <SortIcon field="INVITATIONS_LEFT" />
                    </A>
                  </TableHead>
                  <TableHead class="whitespace-nowrap">
                    {t`Invited by`}
                  </TableHead>
                  <TableHead class="text-right">
                    <A
                      href={sortHref("INVITED")}
                      class="inline-flex items-center justify-end hover:text-foreground transition-colors"
                    >
                      {t`Invited`}
                      <SortIcon field="INVITED" />
                    </A>
                  </TableHead>
                  <TableHead class="whitespace-nowrap">
                    <A
                      href={sortHref("LAST_ACTIVITY")}
                      class="inline-flex items-center hover:text-foreground transition-colors"
                    >
                      {t`Last activity`}
                      <SortIcon field="LAST_ACTIVITY" />
                    </A>
                  </TableHead>
                  <TableHead>
                    <A
                      href={sortHref("CREATED")}
                      class="inline-flex items-center hover:text-foreground transition-colors"
                    >
                      {t`Created`}
                      <SortIcon field="CREATED" />
                    </A>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <For each={conn.edges}>
                  {(edge) => (
                    <TableRow>
                      <TableCell>
                        <A
                          href={`/@${edge.node.username}`}
                          class="flex items-center gap-2 hover:underline"
                        >
                          <Avatar class="size-9 shrink-0">
                            <AvatarImage
                              src={edge.node.avatarUrl}
                              width={36}
                              height={36}
                            />
                          </Avatar>
                          <span class="flex flex-col leading-tight">
                            <span class="font-semibold">
                              {edge.node.name}
                            </span>
                            <span class="text-xs text-muted-foreground">
                              {edge.node.handle}
                            </span>
                          </span>
                        </A>
                      </TableCell>
                      <TableCell class="text-right">
                        <A
                          href={`/@${edge.node.username}/following`}
                          class="hover:underline"
                        >
                          {formatNumber(
                            edge.node.actor.followees.totalCount,
                          )}
                        </A>
                      </TableCell>
                      <TableCell class="text-right">
                        <A
                          href={`/@${edge.node.username}/followers`}
                          class="hover:underline"
                        >
                          {formatNumber(
                            edge.node.actor.followers.totalCount,
                          )}
                        </A>
                      </TableCell>
                      <TableCell class="text-right">
                        {formatNumber(edge.node.postCount ?? 0)}
                      </TableCell>
                      <TableCell class="text-right">
                        {formatNumber(edge.node.invitationsLeft)}
                      </TableCell>
                      <TableCell>
                        {
                          /* `keyed`: avoid Solid's stale-accessor race
                           when this Relay field flips to null inside a
                           `batch()` update. */
                        }
                        <Show keyed when={edge.node.inviter}>
                          {(inviter) => (
                            <A
                              href={`/@${inviter.username}`}
                              class="flex items-center gap-2 hover:underline"
                            >
                              <Avatar class="size-4 shrink-0">
                                <AvatarImage
                                  src={inviter.avatarUrl}
                                  width={16}
                                  height={16}
                                />
                              </Avatar>
                              <span class="flex items-baseline gap-1">
                                <span class="font-semibold">
                                  {inviter.name}
                                </span>
                                <span class="text-xs text-muted-foreground/70">
                                  @{inviter.username}
                                </span>
                              </span>
                            </A>
                          )}
                        </Show>
                      </TableCell>
                      <TableCell class="text-right">
                        {formatNumber(edge.node.invitees.totalCount)}
                      </TableCell>
                      <TableCell>
                        <Timestamp
                          value={edge.lastActivity}
                          relativeStyle="narrow"
                        />
                      </TableCell>
                      <TableCell>
                        <Timestamp
                          value={edge.node.created}
                          relativeStyle="narrow"
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </For>
              </TableBody>
            </Table>
            <Show when={data.hasNext}>
              <div class="border-t p-4 text-center">
                <Button
                  variant="outline"
                  on:click={onLoadMore}
                  disabled={data.pending || loadingState() === "loading"}
                >
                  <Switch>
                    <Match
                      when={data.pending || loadingState() === "loading"}
                    >
                      {t`Loading more accounts…`}
                    </Match>
                    <Match when={loadingState() === "errored"}>
                      {t`Failed to load more accounts; click to retry`}
                    </Match>
                    <Match when={loadingState() === "loaded"}>
                      {t`Load more accounts`}
                    </Match>
                  </Switch>
                </Button>
              </div>
            </Show>
          </div>
        </>
      )}
    </Show>
  );
}
