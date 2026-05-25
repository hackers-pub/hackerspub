import { graphql } from "relay-runtime";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import {
  getExistingWebPushSubscription,
  getNotificationPermission,
  isWebPushSupported,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  WEB_PUSH_PERMISSION_CHANGE_EVENT,
} from "~/lib/webPush.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { WebPushPromptBannerRegisterMutation } from "./__generated__/WebPushPromptBannerRegisterMutation.graphql.ts";
import IconBell from "~icons/lucide/bell";
import IconX from "~icons/lucide/x";

export interface WebPushPromptBannerProps {
  enabled: boolean;
  vapidPublicKey?: string | null;
}

const DISMISSED_KEY = "hackerspub.webPushPrompt.dismissed";

const registerMutation = graphql`
  mutation WebPushPromptBannerRegisterMutation(
    $endpoint: String!,
    $p256dh: String!,
    $auth: String!,
    $expirationTime: DateTime
  ) {
    registerPushNotificationTarget(input: {
      service: WEB_PUSH,
      endpoint: $endpoint,
      p256dh: $p256dh,
      auth: $auth,
      expirationTime: $expirationTime
    }) {
      __typename
      ... on RegisterPushNotificationTargetPayload {
        endpoint
      }
    }
  }
`;

export function WebPushPromptBanner(props: WebPushPromptBannerProps) {
  const { t } = useLingui();
  const [registerTarget, registering] = createMutation<
    WebPushPromptBannerRegisterMutation
  >(registerMutation);
  const [mounted, setMounted] = createSignal(false);
  const [dismissed, setDismissed] = createSignal(true);
  const [supported, setSupported] = createSignal(false);
  const [permission, setPermission] = createSignal<
    NotificationPermission | null
  >(
    null,
  );
  const [subscribed, setSubscribed] = createSignal(true);

  const visible = () =>
    mounted() &&
    props.enabled &&
    props.vapidPublicKey != null &&
    supported() &&
    permission() !== "denied" &&
    !subscribed() &&
    !dismissed();

  onMount(() => {
    setMounted(true);
    setDismissed(localStorage.getItem(DISMISSED_KEY) === "1");
    setSupported(isWebPushSupported());
    setPermission(getNotificationPermission());
    const updatePermission = () => setPermission(getNotificationPermission());
    window.addEventListener(
      WEB_PUSH_PERMISSION_CHANGE_EVENT,
      updatePermission,
    );
    onCleanup(() => {
      window.removeEventListener(
        WEB_PUSH_PERMISSION_CHANGE_EVENT,
        updatePermission,
      );
    });
    void (async () => {
      try {
        const subscription = await getExistingWebPushSubscription();
        setSubscribed(subscription != null);
      } catch (error) {
        console.error(error);
        setSubscribed(false);
      }
    })();
  });

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  }

  async function enablePush() {
    const vapidPublicKey = props.vapidPublicKey;
    if (vapidPublicKey == null) return;
    try {
      const subscription = await subscribeToWebPush(vapidPublicKey);
      registerTarget({
        variables: subscription,
        onCompleted(response) {
          if (
            response.registerPushNotificationTarget?.__typename !==
              "RegisterPushNotificationTargetPayload"
          ) {
            showToast({
              title: t`Failed to enable browser notifications`,
              variant: "error",
            });
            void unsubscribeFromWebPush();
            return;
          }
          localStorage.setItem(DISMISSED_KEY, "1");
          setDismissed(true);
          setSubscribed(true);
          setPermission(getNotificationPermission());
          showToast({
            title: t`Browser notifications enabled`,
            variant: "success",
          });
        },
        onError(error) {
          console.error(error);
          showToast({
            title: t`Failed to enable browser notifications`,
            description: import.meta.env.DEV ? error.message : undefined,
            variant: "error",
          });
        },
      });
    } catch (error) {
      setPermission(getNotificationPermission());
      showToast({
        title: t`Failed to enable browser notifications`,
        description: error instanceof Error ? error.message : undefined,
        variant: "error",
      });
    }
  }

  return (
    <Show when={visible()}>
      <div class="border-b bg-muted/60 px-4 py-3">
        <div class="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex min-w-0 items-start gap-3">
            <IconBell class="mt-0.5 size-5 shrink-0 text-primary" />
            <div class="min-w-0 space-y-1">
              <p class="text-sm font-medium">
                {t`Get browser notifications`}
              </p>
              <p class="text-sm text-muted-foreground">
                {t`Receive new notifications immediately, even when this tab is closed.`}
              </p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void enablePush()}
              disabled={registering()}
            >
              {registering() ? t`Enabling…` : t`Enable`}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t`Dismiss`}
              onClick={dismiss}
            >
              <IconX class="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
