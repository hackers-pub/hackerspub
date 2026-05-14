import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
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

export function AdminAccountsTable(props: AdminAccountsTableProps) {
  const { i18n, t } = useLingui();
  const data = createPaginationFragment(
    graphql`
      fragment AdminAccountsTable_query on Query
        @refetchable(queryName: "AdminAccountsTablePaginationQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 100 }
        )
      {
        adminAccounts(after: $cursor, first: $count)
          @connection(key: "AdminAccountsTable_adminAccounts")
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
          <p class="mb-4 text-sm text-muted-foreground">
            {t`Total: ${formatNumber(conn.totalCount)}`}
          </p>
          <div class="rounded-lg border bg-card shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t`Account`}</TableHead>
                  <TableHead class="text-right">
                    {t`Following`}
                  </TableHead>
                  <TableHead class="text-right">
                    {t`Followers`}
                  </TableHead>
                  <TableHead class="text-right">
                    {t`Posts`}
                  </TableHead>
                  <TableHead class="text-right whitespace-nowrap">
                    {t`Invitations left`}
                  </TableHead>
                  <TableHead class="whitespace-nowrap">
                    {t`Invited by`}
                  </TableHead>
                  <TableHead class="text-right">
                    {t`Invited`}
                  </TableHead>
                  <TableHead class="whitespace-nowrap">
                    {t`Last activity`}
                  </TableHead>
                  <TableHead>{t`Created`}</TableHead>
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
