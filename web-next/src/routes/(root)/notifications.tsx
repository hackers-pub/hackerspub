import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, For, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ModerationNotificationList } from "~/components/ModerationNotificationList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotificationList } from "~/components/NotificationList.tsx";
import { Title } from "~/components/Title.tsx";
import { WebPushNotificationSettings } from "~/components/WebPushNotificationSettings.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { NOTIFICATIONS_PAGE_QUERY_CACHE_KEY } from "~/lib/notificationsPageQueryCache.ts";
import type {
  notificationsPageQuery,
  notificationsPageQuery$data,
} from "./__generated__/notificationsPageQuery.graphql.ts";
import type { notificationsOrganizationNotificationsQuery } from "./__generated__/notificationsOrganizationNotificationsQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

const notificationsPageQuery = graphql`
  query notificationsPageQuery {
    webPushVapidPublicKey
    viewer {
      ...WebPushNotificationSettings_account
      ...ModerationNotificationList_account
      ...NotificationList_notifications
    }
  }
`;

const notificationsOrganizationNotificationsQuery = graphql`
  query notificationsOrganizationNotificationsQuery($organizationId: ID!) {
    node(id: $organizationId) {
      __typename
      ... on Account {
        id
        ...NotificationList_notifications
      }
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  () =>
    loadQuery<notificationsPageQuery>(
      useRelayEnvironment()(),
      notificationsPageQuery,
      {},
      // NotificationList marks notifications as read through the first loaded
      // edge, so it must not run against a stale cached connection snapshot.
      { fetchPolicy: "network-only" },
    ),
  NOTIFICATIONS_PAGE_QUERY_CACHE_KEY,
);

export default function NotificationsPage() {
  const { t } = useLingui();
  const data = createStablePreloadedQuery<notificationsPageQuery>(
    notificationsPageQuery,
    () => loadPageQuery(),
  );
  return (
    <NarrowContainer>
      <Title>{t`Hackers' Pub: Notifications`}</Title>
      <div class="p-4">
        <Show keyed when={data()}>
          {(data) => (
            <Show
              keyed
              when={data.viewer}
              fallback={<Navigate href="/sign?next=%2Fnotifications" />}
            >
              {(viewer) => (
                <NotificationsPageContent
                  viewer={viewer}
                  vapidPublicKey={data.webPushVapidPublicKey}
                />
              )}
            </Show>
          )}
        </Show>
      </div>
    </NarrowContainer>
  );
}

type NotificationsPageViewer = NonNullable<
  notificationsPageQuery$data[
    "viewer"
  ]
>;

interface NotificationsPageContentProps {
  viewer: NotificationsPageViewer;
  vapidPublicKey?: string | null;
}

function NotificationsPageContent(props: NotificationsPageContentProps) {
  const actingAccount = useActingAccount();
  const environment = useRelayEnvironment();
  const selectedOrganizationId = createMemo(() =>
    actingAccount.selectedOrganization()?.organization.id ?? null
  );
  const organizationData = createPreloadedQuery<
    notificationsOrganizationNotificationsQuery
  >(
    notificationsOrganizationNotificationsQuery,
    () => {
      const organizationId = selectedOrganizationId();
      if (organizationId == null) return null;
      return loadQuery<notificationsOrganizationNotificationsQuery>(
        environment(),
        notificationsOrganizationNotificationsQuery,
        { organizationId },
        // Organization notification lists also mark the visible range as read,
        // so avoid reusing a stale connection snapshot here.
        { fetchPolicy: "network-only" },
      );
    },
  );
  const organizationAccount = createMemo(() => {
    const node = organizationData()?.node;
    return node?.__typename === "Account" &&
        node.id === selectedOrganizationId()
      ? node
      : null;
  });

  return (
    <Show
      keyed
      when={selectedOrganizationId()}
      fallback={
        <PersonalNotificationsPanel
          viewer={props.viewer}
          vapidPublicKey={props.vapidPublicKey}
        />
      }
    >
      {(organizationId) => (
        <Show
          keyed
          when={organizationAccount()}
          fallback={<NotificationListSkeleton />}
        >
          {(organization) => (
            <div class="flex flex-col gap-4">
              <NotificationList
                $account={organization}
                readScope={{
                  kind: "organization",
                  organizationId,
                }}
              />
            </div>
          )}
        </Show>
      )}
    </Show>
  );
}

function PersonalNotificationsPanel(props: NotificationsPageContentProps) {
  return (
    <div class="flex flex-col gap-4">
      <WebPushNotificationSettings
        $account={props.viewer}
        vapidPublicKey={props.vapidPublicKey}
      />
      <ModerationNotificationList $account={props.viewer} />
      <NotificationList $account={props.viewer} />
    </div>
  );
}

function NotificationListSkeleton() {
  return (
    <div
      class="overflow-hidden rounded-lg border bg-card shadow-sm"
      aria-busy="true"
    >
      <For each={[0, 1, 2]}>
        {() => (
          <div class="border-b p-4 last:border-b-0">
            <div class="flex gap-3">
              <div class="size-10 shrink-0 rounded-full bg-muted animate-pulse" />
              <div class="min-w-0 flex-1 space-y-3">
                <div class="flex items-center gap-2">
                  <div class="h-4 w-28 rounded bg-muted animate-pulse" />
                  <div class="h-3 w-20 rounded bg-muted animate-pulse" />
                </div>
                <div class="space-y-2">
                  <div class="h-4 w-full rounded bg-muted animate-pulse" />
                  <div class="h-4 w-5/6 rounded bg-muted animate-pulse" />
                </div>
              </div>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
