import { A } from "@solidjs/router";
import { fetchQuery, graphql } from "relay-runtime";
import { createEffect, createMemo, For, Show } from "solid-js";
import {
  createMutation,
  createPaginationFragment,
  useRelayEnvironment,
} from "solid-relay";
import IconShieldAlert from "~icons/lucide/shield-alert";
import { Timestamp } from "~/components/Timestamp.tsx";
import { createChunkedVisibleCount } from "~/lib/deferredRender.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { ModerationNotificationListMarkReadMutation } from "./__generated__/ModerationNotificationListMarkReadMutation.graphql.ts";
import type { ModerationNotificationListUnreadCountQuery } from "./__generated__/ModerationNotificationListUnreadCountQuery.graphql.ts";
import type { ModerationNotificationList_account$key } from "./__generated__/ModerationNotificationList_account.graphql.ts";

export interface ModerationNotificationListProps {
  $account: ModerationNotificationList_account$key;
}

const markReadMutation = graphql`
  mutation ModerationNotificationListMarkReadMutation($upToId: ID) {
    markModerationNotificationsRead(upToId: $upToId)
  }
`;

const unreadCountQuery = graphql`
  query ModerationNotificationListUnreadCountQuery {
    viewer {
      unreadModerationNotificationCount
    }
  }
`;

export function ModerationNotificationList(
  props: ModerationNotificationListProps,
) {
  const { t } = useLingui();
  const environment = useRelayEnvironment();
  const [markRead] =
    createMutation<ModerationNotificationListMarkReadMutation>(
      markReadMutation,
    );

  const data = createPaginationFragment(
    graphql`
      fragment ModerationNotificationList_account on Account
      @refetchable(queryName: "ModerationNotificationListQuery")
      @argumentDefinitions(
        cursor: { type: "String" }
        count: { type: "Int", defaultValue: 20 }
      ) {
        username
        moderationNotifications(after: $cursor, first: $count)
          @connection(
            key: "ModerationNotificationList_moderationNotifications"
          ) {
          edges {
            node {
              id
              uuid
              type
              read
              created
              case {
                uuid
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
  const notificationEdges = createMemo(
    () => data()?.moderationNotifications?.edges ?? [],
  );
  const visibleNotificationCount = createChunkedVisibleCount(
    () => notificationEdges().length,
  );
  const visibleNotificationEdges = createMemo(() =>
    notificationEdges().slice(0, visibleNotificationCount()),
  );

  let marked = false;
  createEffect(() => {
    const value = data();
    if (marked || value == null) return;
    const edges = value.moderationNotifications?.edges ?? [];
    const newest = edges[0]?.node;
    if (newest == null || newest.read != null) return;
    marked = true;
    // Marking "up to the newest" covers every loaded notification, so mark
    // all currently-loaded unread records read in the store too — the
    // Int-returning mutation can't do it, and otherwise the unread dots
    // would linger until the next full page load.
    const read = new Date().toISOString();
    const unreadIds = edges
      .filter((edge) => edge.node.read == null)
      .map((edge) => edge.node.id);
    markRead({
      variables: { upToId: newest.id },
      updater(store) {
        for (const id of unreadIds) {
          store.get(id)?.setValue(read, "read");
        }
      },
      onCompleted() {
        fetchQuery<ModerationNotificationListUnreadCountQuery>(
          environment(),
          unreadCountQuery,
          {},
        ).subscribe({});
      },
    });
  });

  const typeLabel = (type: string) => {
    switch (type) {
      case "FLAG_RECEIVED":
        return t`A new report needs review.`;
      case "ACTION_TAKEN":
        return t`A moderation decision was made about your account.`;
      case "APPEAL_RECEIVED":
        return t`A new appeal needs review.`;
      case "APPEAL_RESOLVED":
        return t`Your appeal was reviewed.`;
      case "SUSPENSION_ENDING":
        return t`Your suspension ends soon.`;
      default:
        return type;
    }
  };

  const linkFor = (node: {
    type: string;
    case: { uuid: string } | null | undefined;
    username: string;
  }) => {
    switch (node.type) {
      case "FLAG_RECEIVED":
        return node.case
          ? `/admin/moderation/${node.case.uuid}`
          : "/admin/moderation";
      case "APPEAL_RECEIVED":
        return "/admin/moderation/appeals";
      default:
        return `/@${node.username}/settings/moderation`;
    }
  };

  return (
    <Show keyed when={data()}>
      {(value) => (
        <Show when={(value.moderationNotifications?.edges.length ?? 0) > 0}>
          <section class="flex flex-col gap-2">
            <h2 class="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <IconShieldAlert class="size-4" aria-hidden="true" />
              {t`Moderation`}
            </h2>
            <ul class="flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
              <For each={visibleNotificationEdges()}>
                {(edge) => (
                  <li>
                    <A
                      href={linkFor({
                        type: edge.node.type,
                        case: edge.node.case,
                        username: value.username,
                      })}
                      class="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                      classList={{ "bg-primary/5": edge.node.read == null }}
                    >
                      <Show when={edge.node.read == null}>
                        <span
                          class="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                          aria-label={t`Unread`}
                        />
                      </Show>
                      <div class="flex min-w-0 grow flex-col">
                        <p class="text-sm">{typeLabel(edge.node.type)}</p>
                        <span class="text-xs text-muted-foreground">
                          <Timestamp value={edge.node.created} />
                        </span>
                      </div>
                    </A>
                  </li>
                )}
              </For>
              <Show
                when={
                  data.hasNext &&
                  visibleNotificationCount() >= notificationEdges().length
                }
              >
                <li>
                  <button
                    type="button"
                    onClick={() => data.loadNext(20)}
                    disabled={data.pending}
                    class="block w-full cursor-pointer px-4 py-4 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t`Load more`}
                  </button>
                </li>
              </Show>
            </ul>
          </section>
        </Show>
      )}
    </Show>
  );
}
