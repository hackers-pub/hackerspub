import { fetchQuery, graphql, type Subscription } from "relay-runtime";
import {
  type Accessor,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { useRelayEnvironment } from "solid-relay";

import type { unreadNotificationsCountQuery } from "./__generated__/unreadNotificationsCountQuery.graphql.ts";

const UnreadNotificationsCountQuery = graphql`
  query unreadNotificationsCountQuery {
    viewer {
      unreadNotificationsCount
      unreadModerationNotificationCount
    }
  }
`;

export interface UnreadNotificationsCountAccount {
  username?: string | null;
  unreadNotificationsCount?: number | null;
  unreadModerationNotificationCount?: number | null;
}

export function createUnreadNotificationsCount(
  account: Accessor<UnreadNotificationsCountAccount | null | undefined>,
): Accessor<number | undefined> {
  const environment = useRelayEnvironment();
  const [unreadNotificationsCount, setUnreadNotificationsCount] = createSignal<
    number
  >();
  const [
    unreadModerationNotificationCount,
    setUnreadModerationNotificationCount,
  ] = createSignal<number>();
  const [documentVisible, setDocumentVisible] = createSignal(false);

  createEffect(() => {
    const value = account();
    setUnreadNotificationsCount(value?.unreadNotificationsCount ?? undefined);
    setUnreadModerationNotificationCount(
      value?.unreadModerationNotificationCount ?? undefined,
    );
  });

  onMount(() => {
    const onVisibilityChange = () => {
      setDocumentVisible(document.visibilityState === "visible");
    };
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  });

  createEffect(() => {
    if (account()?.username == null || !documentVisible()) return;

    let pending: Subscription | null = null;
    const poll = () => {
      if (pending != null) return;
      pending = fetchQuery<unreadNotificationsCountQuery>(
        environment(),
        UnreadNotificationsCountQuery,
        {},
      ).subscribe({
        next(data) {
          setUnreadNotificationsCount(
            data.viewer?.unreadNotificationsCount ?? undefined,
          );
          setUnreadModerationNotificationCount(
            data.viewer?.unreadModerationNotificationCount ?? undefined,
          );
        },
        complete() {
          pending = null;
        },
        error(error: unknown) {
          pending = null;
          console.error("Notification count polling failed:", error);
        },
      });
    };

    const interval = setInterval(poll, 10_000);
    onCleanup(() => {
      clearInterval(interval);
      pending?.unsubscribe();
    });
  });

  return () => {
    const regular = unreadNotificationsCount();
    const moderation = unreadModerationNotificationCount();
    if (regular == null && moderation == null) return undefined;
    return (regular ?? 0) + (moderation ?? 0);
  };
}
