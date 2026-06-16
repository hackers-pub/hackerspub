import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { ModerationNotificationList } from "~/components/ModerationNotificationList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotificationList } from "~/components/NotificationList.tsx";
import { Title } from "~/components/Title.tsx";
import { WebPushNotificationSettings } from "~/components/WebPushNotificationSettings.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { NOTIFICATIONS_PAGE_QUERY_CACHE_KEY } from "~/lib/notificationsPageQueryCache.ts";
import type { notificationsPageQuery } from "./__generated__/notificationsPageQuery.graphql.ts";
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
                <div class="flex flex-col gap-4">
                  <WebPushNotificationSettings
                    $account={viewer}
                    vapidPublicKey={data.webPushVapidPublicKey}
                  />
                  <ModerationNotificationList $account={viewer} />
                  <NotificationList $account={viewer} />
                </div>
              )}
            </Show>
          )}
        </Show>
      </div>
    </NarrowContainer>
  );
}
