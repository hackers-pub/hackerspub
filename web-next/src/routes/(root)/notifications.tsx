import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
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
      organizationMemberships {
        organization {
          id
          ...NotificationList_notifications
        }
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
  const selectedOrganizationAccount = createMemo(() => {
    const selectedOrganizationId = actingAccount.selectedOrganization()
      ?.organization.id;
    if (selectedOrganizationId == null) return null;
    return props.viewer.organizationMemberships.find((membership) =>
      membership.organization.id === selectedOrganizationId
    )?.organization ?? null;
  });

  return (
    <Show
      keyed
      when={selectedOrganizationAccount()}
      fallback={
        <PersonalNotificationsPanel
          viewer={props.viewer}
          vapidPublicKey={props.vapidPublicKey}
        />
      }
    >
      {(organization) => (
        <div class="flex flex-col gap-4">
          <NotificationList
            $account={organization}
            readScope={{
              kind: "organization",
              organizationId: organization.id,
            }}
          />
        </div>
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
