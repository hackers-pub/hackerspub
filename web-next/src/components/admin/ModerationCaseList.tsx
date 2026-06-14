import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import IconFileText from "~icons/lucide/file-text";
import IconUser from "~icons/lucide/user";
import { Timestamp } from "~/components/Timestamp.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ModerationCaseList_query$key } from "./__generated__/ModerationCaseList_query.graphql.ts";

/** Cases at or above this report count are highlighted as high priority. */
export const HIGH_PRIORITY_REPORT_COUNT = 5;

const PAGE_SIZE = 30 as const;

export interface ModerationCaseListProps {
  $query: ModerationCaseList_query$key;
}

export function ModerationCaseList(props: ModerationCaseListProps) {
  const { t } = useLingui();
  const data = createPaginationFragment(
    graphql`
      fragment ModerationCaseList_query on Query
        @refetchable(queryName: "ModerationCaseListPaginationQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 30 }
          status: { type: "FlagStatus" }
          minReportCount: { type: "Int" }
          search: { type: "String" }
        )
      {
        moderationCases(
          after: $cursor
          first: $count
          status: $status
          minReportCount: $minReportCount
          search: $search
        )
          @connection(
            key: "ModerationCaseList_moderationCases"
            filters: ["status", "minReportCount", "search"]
          )
        {
          edges {
            node {
              id
              uuid
              status
              reportCount
              created
              targetPostIri
              targetActor {
                name
                handle
                username
                local
                avatarUrl
                avatarInitials
              }
              assignedModerator {
                username
                name
                handle
                avatarUrl
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
    data.loadNext(PAGE_SIZE, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  const statusLabel = (status: string) => {
    switch (status) {
      case "PENDING":
        return t`Pending`;
      case "REVIEWING":
        return t`Reviewing`;
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

  const edges = () => data()?.moderationCases?.edges ?? [];

  return (
    <Show
      when={edges().length > 0}
      fallback={
        <p class="px-4 py-12 text-center text-muted-foreground">
          {t`No cases match these filters.`}
        </p>
      }
    >
      <ul class="divide-y divide-solid rounded-md border">
        <For each={edges()}>
          {(edge) => {
            const node = edge.node;
            const highPriority = node.reportCount >= HIGH_PRIORITY_REPORT_COUNT;
            return (
              <li
                classList={{
                  "transition-colors hover:bg-muted/40": true,
                  "bg-error/30": highPriority,
                }}
              >
                <A
                  href={`/admin/moderation/${node.uuid}`}
                  class="flex items-center gap-3 px-4 py-3"
                >
                  <Avatar class="size-10 shrink-0">
                    <AvatarImage
                      src={node.targetActor.avatarUrl}
                      class="size-10"
                    />
                    <AvatarFallback class="size-10">
                      {node.targetActor.avatarInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div class="flex min-w-0 grow flex-col">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <Show
                        when={node.targetPostIri != null}
                        fallback={
                          <IconUser class="size-3.5 shrink-0 text-muted-foreground" />
                        }
                      >
                        <IconFileText class="size-3.5 shrink-0 text-muted-foreground" />
                      </Show>
                      <span class="truncate font-medium">
                        <Show
                          when={(node.targetActor.name ?? "").trim() !== ""}
                          fallback={node.targetActor.username}
                        >
                          <span innerHTML={node.targetActor.name ?? ""} />
                        </Show>
                      </span>
                    </div>
                    <span
                      class="truncate text-sm text-muted-foreground"
                      title={node.targetActor.handle}
                    >
                      {node.targetActor.handle}
                    </span>
                    <Show when={node.assignedModerator}>
                      {(moderator) => (
                        <span class="mt-0.5 truncate text-xs text-muted-foreground">
                          {t`Assigned to ${
                            moderator().name ??
                              moderator().username
                          }`}
                        </span>
                      )}
                    </Show>
                  </div>
                  <div class="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge variant={statusVariant(node.status)}>
                      {statusLabel(node.status)}
                    </Badge>
                    <Badge variant={highPriority ? "error" : "outline"}>
                      <Show
                        when={node.reportCount === 1}
                        fallback={t`${node.reportCount} reports`}
                      >
                        {t`1 report`}
                      </Show>
                    </Badge>
                    <span class="text-xs text-muted-foreground">
                      <Timestamp value={node.created} />
                    </span>
                  </div>
                </A>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={data.hasNext}>
        <button
          type="button"
          onClick={onLoadMore}
          disabled={data.pending || loadingState() === "loading"}
          class="mt-2 block w-full cursor-pointer rounded-md px-4 py-4 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Switch>
            <Match when={data.pending || loadingState() === "loading"}>
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
  );
}
