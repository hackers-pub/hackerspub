import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.ts";
import type { InvitationGrantedNotificationCard_notification$key } from "~/__generated__/InvitationGrantedNotificationCard_notification.graphql.ts";

interface InvitationGrantedNotificationCardProps {
  $notification: InvitationGrantedNotificationCard_notification$key;
}

export function InvitationGrantedNotificationCard(
  props: InvitationGrantedNotificationCardProps,
) {
  const { i18n, t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment InvitationGrantedNotificationCard_notification on InvitationGrantedNotification {
        ...NotificationMessage_notification
        amount
        automatic
      }
    `,
    () => props.$notification,
  );

  return (
    <Show keyed when={notification()}>
      {(notification) => (
        <Show
          when={notification.automatic}
          fallback={
            <NotificationMessage
              singleActorMessage={t`${"ACTOR"} granted you ${plural(
                notification.amount,
                {
                  one: "# invitation",
                  other: "# invitations",
                },
              )}`}
              multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others granted you ${plural(
                notification.amount,
                {
                  one: "# invitation",
                  other: "# invitations",
                },
              )}`}
              $notification={notification}
            />
          }
        >
          <div class="m-4 leading-6">
            {i18n._(
              msg`You received ${plural(notification.amount, {
                one: "# invitation",
                other: "# invitations",
              })} from Hackers' Pub.`,
            )}
          </div>
        </Show>
      )}
    </Show>
  );
}
