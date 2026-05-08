import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotificationList } from "~/components/NotificationList.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { notificationsPageQuery } from "./__generated__/notificationsPageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

const notificationsPageQuery = graphql`
  query notificationsPageQuery {
    viewer {
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
  "loadNotificationsPageQuery",
);

export default function NotificationsPage() {
  const { t } = useLingui();
  const data = createPreloadedQuery<notificationsPageQuery>(
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
              {(viewer) => <NotificationList $account={viewer} />}
            </Show>
          )}
        </Show>
      </div>
    </NarrowContainer>
  );
}
