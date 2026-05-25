import { graphql } from "relay-runtime";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import {
  getNotificationPermission,
  getReusableWebPushSubscriptionData,
  isWebPushSupported,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  WEB_PUSH_PERMISSION_CHANGE_EVENT,
  type WebPushSubscriptionData,
} from "~/lib/webPush.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { WebPushPromptBannerRegisterMutation } from "./__generated__/WebPushPromptBannerRegisterMutation.graphql.ts";
import IconBell from "~icons/lucide/bell";
import IconX from "~icons/lucide/x";

export interface WebPushPromptBannerProps {
  enabled: boolean;
  loaded: boolean;
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
  const [refreshingEndpoint, setRefreshingEndpoint] = createSignal<
    string | null
  >(null);
  let refreshVersion = 0;
  let wasEnabled = false;

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
  });

  createEffect(() => {
    const vapidPublicKey = props.vapidPublicKey;
    if (!mounted() || !props.loaded) return;
    if (!props.enabled) {
      const shouldCleanup = wasEnabled;
      wasEnabled = false;
      refreshVersion++;
      if (shouldCleanup) cleanupBrowserSubscription();
      setSubscribed(false);
      setRefreshingEndpoint(null);
      return;
    }
    wasEnabled = true;
    if (vapidPublicKey == null || !supported()) return;
    void refreshExistingSubscription(vapidPublicKey);
  });

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  }

  function cleanupBrowserSubscription() {
    void unsubscribeFromWebPush().catch((error) => console.error(error));
  }

  async function refreshExistingSubscription(vapidPublicKey: string) {
    const currentRefresh = ++refreshVersion;
    try {
      const subscription = await getReusableWebPushSubscriptionData(
        vapidPublicKey,
      );
      if (currentRefresh !== refreshVersion) return;
      if (subscription == null) {
        setSubscribed(false);
        setRefreshingEndpoint(null);
        return;
      }
      if (refreshingEndpoint() === subscription.endpoint) return;
      setRefreshingEndpoint(subscription.endpoint);
      setSubscribed(true);
      registerSubscription(subscription, { silent: true });
    } catch (error) {
      console.error(error);
      cleanupBrowserSubscription();
      setSubscribed(false);
      setRefreshingEndpoint(null);
    }
  }

  function registerSubscription(
    subscription: WebPushSubscriptionData,
    options: { silent?: boolean } = {},
  ) {
    registerTarget({
      variables: subscription,
      onCompleted(response) {
        if (
          response.registerPushNotificationTarget?.__typename !==
            "RegisterPushNotificationTargetPayload"
        ) {
          if (!options.silent) {
            showToast({
              title: t`Failed to enable browser notifications`,
              variant: "error",
            });
            cleanupBrowserSubscription();
            setSubscribed(false);
          } else {
            setSubscribed(true);
          }
          setRefreshingEndpoint(null);
          return;
        }
        if (!options.silent) {
          localStorage.setItem(DISMISSED_KEY, "1");
          setDismissed(true);
          showToast({
            title: t`Browser notifications enabled`,
            variant: "success",
          });
        }
        setSubscribed(true);
        setPermission(getNotificationPermission());
        setRefreshingEndpoint(null);
      },
      onError(error) {
        console.error(error);
        if (!options.silent) {
          cleanupBrowserSubscription();
          setSubscribed(false);
        } else {
          setSubscribed(true);
        }
        setRefreshingEndpoint(null);
        if (!options.silent) {
          showToast({
            title: t`Failed to enable browser notifications`,
            description: import.meta.env.DEV ? error.message : undefined,
            variant: "error",
          });
        }
      },
    });
  }

  async function enablePush() {
    const vapidPublicKey = props.vapidPublicKey;
    if (vapidPublicKey == null) return;
    try {
      const subscription = await subscribeToWebPush(vapidPublicKey);
      registerSubscription(subscription);
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
