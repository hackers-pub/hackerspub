import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import IconFileText from "~icons/lucide/file-text";
import IconUser from "~icons/lucide/user";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ReportHistoryList_account$key } from "./__generated__/ReportHistoryList_account.graphql.ts";

export interface ReportHistoryListProps {
  $account: ReportHistoryList_account$key;
}

const PAGE_SIZE = 20 as const;

export function ReportHistoryList(props: ReportHistoryListProps) {
  const { t } = useLingui();
  const reports = createPaginationFragment(
    graphql`
      fragment ReportHistoryList_account on Account
        @refetchable(queryName: "ReportHistoryListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        reports(after: $cursor, first: $count)
          @connection(key: "ReportHistoryList_reports")
        {
          edges {
            node {
              id
              reason
              status
              forwardToRemote
              created
              targetPostIri
              targetActor {
                name
                handle
                username
                local
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$account,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    reports.loadNext(PAGE_SIZE, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  const profileHref = (
    actor: { local: boolean; username: string; handle: string },
  ) => `/${actor.local ? `@${actor.username}` : actor.handle}`;

  // `targetPostIri` originates from remote ActivityPub data, so only link it
  // when it is an `http(s)` URL; otherwise (e.g. a `javascript:` IRI) render
  // the target as plain text to avoid a clickable script-injection vector.
  const safeHttpUrl = (raw: string | null | undefined): string | null => {
    if (raw == null) return null;
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.href
        : null;
    } catch {
      return null;
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case "PENDING":
        return t`Pending review`;
      case "REVIEWING":
        return t`Under review`;
      case "RESOLVED":
        return t`Resolved`;
      case "DISMISSED":
        return t`Dismissed`;
      default:
        return status;
    }
  };

  const statusVariant = (
    status: string,
  ): "secondary" | "warning" | "success" | "outline" => {
    switch (status) {
      case "REVIEWING":
        return "warning";
      case "RESOLVED":
        return "success";
      case "DISMISSED":
        return "outline";
      default:
        return "secondary";
    }
  };

  return (
    <Show keyed when={reports()}>
      {(data) => (
        <Show
          when={(data.reports?.edges.length ?? 0) > 0}
          fallback={
            <p class="px-4 py-8 text-center text-muted-foreground">
              {t`You haven't filed any reports.`}
            </p>
          }
        >
          <ul class="divide-y divide-solid">
            <For each={data.reports?.edges ?? []}>
              {(edge) => {
                const node = edge.node;
                const isPostReport = node.targetPostIri != null;
                const postHref = safeHttpUrl(node.targetPostIri);
                return (
                  <li class="flex flex-col gap-2 px-4 py-4">
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <Switch>
                        <Match when={!isPostReport}>
                          <a
                            href={profileHref(node.targetActor)}
                            class="flex min-w-0 items-center gap-1.5 font-medium hover:underline"
                          >
                            <IconUser class="size-4 shrink-0 text-muted-foreground" />
                            <span class="truncate">
                              {t`Reported ${node.targetActor.handle}`}
                            </span>
                          </a>
                        </Match>
                        <Match when={postHref != null}>
                          <a
                            href={postHref!}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="flex min-w-0 items-center gap-1.5 font-medium hover:underline"
                          >
                            <IconFileText class="size-4 shrink-0 text-muted-foreground" />
                            <span class="truncate">
                              {t`Reported a post by ${node.targetActor.handle}`}
                            </span>
                          </a>
                        </Match>
                        <Match when={isPostReport}>
                          <span class="flex min-w-0 items-center gap-1.5 font-medium">
                            <IconFileText class="size-4 shrink-0 text-muted-foreground" />
                            <span class="truncate">
                              {t`Reported a post by ${node.targetActor.handle}`}
                            </span>
                          </span>
                        </Match>
                      </Switch>
                      <Badge variant={statusVariant(node.status)}>
                        {statusLabel(node.status)}
                      </Badge>
                    </div>
                    <p class="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {node.reason}
                    </p>
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <Timestamp value={node.created} capitalizeFirstLetter />
                      <Show when={node.forwardToRemote}>
                        <span aria-hidden="true">·</span>
                        <span>{t`Forwarded to the remote instance`}</span>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
          <Show when={reports.hasNext}>
            <button
              type="button"
              onClick={onLoadMore}
              disabled={reports.pending || loadingState() === "loading"}
              class="block w-full cursor-pointer px-4 py-6 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Switch>
                <Match when={reports.pending || loadingState() === "loading"}>
                  {t`Loading more…`}
                </Match>
                <Match when={loadingState() === "errored"}>
                  {t`Failed to load more; click to retry`}
                </Match>
                <Match when={loadingState() === "loaded"}>
                  {t`Load more`}
                </Match>
              </Switch>
            </button>
          </Show>
        </Show>
      )}
    </Show>
  );
}
