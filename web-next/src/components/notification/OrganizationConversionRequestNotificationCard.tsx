import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import IconArrowRight from "~icons/lucide/arrow-right";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { OrganizationConversionRequestNotificationCard_notification$key } from "./__generated__/OrganizationConversionRequestNotificationCard_notification.graphql.ts";

interface OrganizationConversionRequestNotificationCardProps {
  $notification: OrganizationConversionRequestNotificationCard_notification$key;
}

export function OrganizationConversionRequestNotificationCard(
  props: OrganizationConversionRequestNotificationCardProps,
) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment OrganizationConversionRequestNotificationCard_notification on OrganizationConversionRequestNotification
      {
        ...NotificationMessage_notification
        request {
          uuid
          accepted
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
            singleActorMessage={t`${"ACTOR"} asked you to accept an organization conversion`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others asked you to accept organization conversions`}
            $notification={notification}
          />
          <div class="-mt-2 mb-4 ml-20 mr-4 flex flex-wrap items-center gap-3">
            <Button
              as={A}
              href={`/organization-conversions/${notification.request.uuid}`}
              variant="outline"
              size="sm"
              preload={false}
            >
              {notification.request.accepted == null
                ? t`Review request`
                : t`View request`}
              <IconArrowRight />
            </Button>
          </div>
        </div>
      )}
    </Show>
  );
}
