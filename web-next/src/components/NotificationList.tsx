import { fetchQuery, graphql } from "relay-runtime";
import { createEffect, createSignal, For, Match, Show, Switch } from "solid-js";
import {
  createMutation,
  createPaginationFragment,
  useRelayEnvironment,
} from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { NotificationListMarkAsReadMutation } from "./__generated__/NotificationListMarkAsReadMutation.graphql.ts";
import type { NotificationListMarkOrganizationNotificationsAsReadMutation } from "./__generated__/NotificationListMarkOrganizationNotificationsAsReadMutation.graphql.ts";
import type { NotificationListUnreadNotificationsQuery } from "./__generated__/NotificationListUnreadNotificationsQuery.graphql.ts";
import type { NotificationList_notifications$key } from "./__generated__/NotificationList_notifications.graphql.ts";
import { NotificationCard } from "./NotificationCard.tsx";

type NotificationListReadScope =
  | { readonly kind: "personal" }
  | { readonly kind: "organization"; readonly organizationId: string };

export interface NotificationListProps {
  $account: NotificationList_notifications$key;
  readScope?: NotificationListReadScope;
}

const NotificationListMarkAsReadMutation = graphql`
  mutation NotificationListMarkAsReadMutation($upTo: UUID) {
    markNotificationsAsRead(upTo: $upTo)
  }
`;

const NotificationListMarkOrganizationNotificationsAsReadMutation = graphql`
  mutation NotificationListMarkOrganizationNotificationsAsReadMutation(
    $organizationId: ID!
    $upTo: UUID
  ) {
    markOrganizationNotificationsAsRead(
      input: { organizationId: $organizationId, upTo: $upTo }
    ) {
      __typename
      ... on MarkOrganizationNotificationsAsReadPayload {
        badge {
          color
          count
        }
      }
    }
  }
`;

const NotificationListUnreadNotificationsQuery = graphql`
  query NotificationListUnreadNotificationsQuery {
    viewer {
      unreadNotificationsCount
      unreadModerationNotificationCount
      organizationMemberships {
        notificationBadge {
          color
          count
        }
      }
    }
  }
`;

export function NotificationList(props: NotificationListProps) {
  const { t } = useLingui();
  const environment = useRelayEnvironment();
  const [markNotificationsAsRead] = createMutation<
    NotificationListMarkAsReadMutation
  >(
    NotificationListMarkAsReadMutation,
  );
  const [markOrganizationNotificationsAsRead] = createMutation<
    NotificationListMarkOrganizationNotificationsAsReadMutation
  >(
    NotificationListMarkOrganizationNotificationsAsReadMutation,
  );
  const notifications = createPaginationFragment(
    graphql`
      fragment NotificationList_notifications on Account
        @refetchable(queryName: "NotificationListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        id
        notifications(after: $cursor, first: $count)
          @connection(key: "NotificationList_notifications")
        {
          edges {
            node {
              uuid
              created
              ...NotificationCard_notification
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
  let markedAccountId: string | null = null;

  function refreshUnreadNotificationsCount() {
    fetchQuery<NotificationListUnreadNotificationsQuery>(
      environment(),
      NotificationListUnreadNotificationsQuery,
      {},
      { fetchPolicy: "network-only" },
    ).subscribe({});
  }

  createEffect(() => {
    const data = notifications();
    if (data == null || markedAccountId === data.id) return;
    const readThrough = data.notifications.edges[0]?.node;
    if (readThrough == null) return;
    markedAccountId = data.id;
    const readScope = props.readScope ?? { kind: "personal" };
    if (readScope.kind === "organization") {
      markOrganizationNotificationsAsRead({
        variables: {
          organizationId: readScope.organizationId,
          upTo: readThrough.uuid,
        },
        // Bound the marker to the newest row in the loaded page so a
        // notification created after this list was fetched remains unread.
        onCompleted: refreshUnreadNotificationsCount,
      });
    } else {
      markNotificationsAsRead({
        variables: { upTo: readThrough.uuid },
        onCompleted: refreshUnreadNotificationsCount,
      });
    }
  });

  function onLoadMore() {
    setLoadingState("loading");
    notifications.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <Show keyed when={notifications()}>
      {(data) => (
        <>
          <ul class="mb-10 flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm md:mb-12">
            <For each={data.notifications.edges}>
              {(edge) => <NotificationCard $notification={edge.node} />}
            </For>
            <Show when={notifications.hasNext}>
              <li>
                <button
                  type="button"
                  on:click={loadingState() === "loading"
                    ? undefined
                    : onLoadMore}
                  disabled={notifications.pending ||
                    loadingState() === "loading"}
                  class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Switch>
                    <Match
                      when={notifications.pending ||
                        loadingState() === "loading"}
                    >
                      {t`Loading more notifications`}
                    </Match>
                    <Match when={loadingState() === "errored"}>
                      {t`Failed to load more notifications; click to retry`}
                    </Match>
                    <Match when={loadingState() === "loaded"}>
                      {t`Load more notifications`}
                    </Match>
                  </Switch>
                </button>
              </li>
            </Show>
          </ul>
        </>
      )}
    </Show>
  );
}
