import { createEffect, on, onCleanup, onMount } from "solid-js";
import { createUnreadNotificationsFaviconBadgeController } from "~/lib/faviconBadge.ts";

export interface UnreadNotificationsFaviconBadgeProps {
  unread: boolean;
}

export function UnreadNotificationsFaviconBadge(
  props: UnreadNotificationsFaviconBadgeProps,
) {
  onMount(() => {
    const controller = createUnreadNotificationsFaviconBadgeController();

    createEffect(
      on(
        () => props.unread,
        (unread) => {
          void controller.setUnread(unread).catch((error: unknown) => {
            console.error(
              "Failed to update favicon notification badge:",
              error,
            );
          });
        },
      ),
    );

    onCleanup(() => {
      controller.dispose();
    });
  });

  return null;
}
