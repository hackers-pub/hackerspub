import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import IconArrowRight from "~icons/lucide/arrow-right";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { OrganizationInvitationNotificationCard_notification$key } from "./__generated__/OrganizationInvitationNotificationCard_notification.graphql.ts";

interface OrganizationInvitationNotificationCardProps {
  $notification: OrganizationInvitationNotificationCard_notification$key;
}

export function OrganizationInvitationNotificationCard(
  props: OrganizationInvitationNotificationCardProps,
) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment OrganizationInvitationNotificationCard_notification on OrganizationInvitationNotification {
        ...NotificationMessage_notification
        membership {
          accepted
          organization {
            username
          }
          member {
            username
          }
        }
      }
    `,
    () => props.$notification,
  );

  return (
    <Show keyed when={notification()}>
      {(notification) => (
        <div>
          <NotificationMessage
            singleActorMessage={t`${"ACTOR"} invited you to join an organization`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others invited you to join organizations`}
            $notification={notification}
          />
          <Show keyed when={notification.membership}>
            {(membership) => (
              <div class="-mt-2 mb-4 ml-20 mr-4 flex flex-wrap items-center gap-3">
                <Button
                  as={A}
                  href={
                    membership.accepted == null
                      ? `/@${membership.member.username}/settings/account`
                      : `/@${membership.organization.username}`
                  }
                  variant="outline"
                  size="sm"
                  preload={false}
                >
                  {membership.accepted == null
                    ? t`Review invitation`
                    : t`View organization`}
                  <IconArrowRight />
                </Button>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
