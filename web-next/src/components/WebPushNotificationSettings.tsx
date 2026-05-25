import { graphql } from "relay-runtime";
import { createSignal, onMount, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import {
  type PushNotificationPreviewPolicy,
  PushNotificationPreviewPolicySelect,
} from "~/components/PushNotificationPreviewPolicySelect.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { Label } from "~/components/ui/label.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import {
  getNotificationPermission,
  getReusableWebPushSubscriptionData,
  isWebPushSupported,
  subscribeToWebPush,
  unsubscribeFromWebPush,
  type WebPushSubscriptionData,
} from "~/lib/webPush.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { WebPushNotificationSettings_account$key } from "./__generated__/WebPushNotificationSettings_account.graphql.ts";
import type { WebPushNotificationSettingsRegisterMutation } from "./__generated__/WebPushNotificationSettingsRegisterMutation.graphql.ts";
import type { WebPushNotificationSettingsUnregisterMutation } from "./__generated__/WebPushNotificationSettingsUnregisterMutation.graphql.ts";
import type { WebPushNotificationSettingsUpdatePolicyMutation } from "./__generated__/WebPushNotificationSettingsUpdatePolicyMutation.graphql.ts";
import IconBell from "~icons/lucide/bell";
import IconBellOff from "~icons/lucide/bell-off";
import IconRefreshCw from "~icons/lucide/refresh-cw";

export interface WebPushNotificationSettingsProps {
  $account: WebPushNotificationSettings_account$key;
  vapidPublicKey?: string | null;
}

const registerMutation = graphql`
  mutation WebPushNotificationSettingsRegisterMutation(
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

const unregisterMutation = graphql`
  mutation WebPushNotificationSettingsUnregisterMutation($endpoint: String!) {
    unregisterPushNotificationTarget(input: {
      service: WEB_PUSH,
      endpoint: $endpoint
    }) {
      __typename
      ... on UnregisterPushNotificationTargetPayload {
        unregistered
      }
    }
  }
`;

const updatePolicyMutation = graphql`
  mutation WebPushNotificationSettingsUpdatePolicyMutation(
    $id: ID!,
    $policy: PushNotificationPreviewPolicy!
  ) {
    updateAccount(input: {
      id: $id,
      pushNotificationPreviewPolicy: $policy
    }) {
      account {
        id
        pushNotificationPreviewPolicy
      }
    }
  }
`;

export function WebPushNotificationSettings(
  props: WebPushNotificationSettingsProps,
) {
  const { t } = useLingui();
  const account = createFragment(
    graphql`
      fragment WebPushNotificationSettings_account on Account {
        id
        pushNotificationPreviewPolicy
      }
    `,
    () => props.$account,
  );
  const [registerTarget, registering] = createMutation<
    WebPushNotificationSettingsRegisterMutation
  >(
    registerMutation,
  );
  const [unregisterTarget, unregistering] = createMutation<
    WebPushNotificationSettingsUnregisterMutation
  >(
    unregisterMutation,
  );
  const [updatePolicy, updatingPolicy] = createMutation<
    WebPushNotificationSettingsUpdatePolicyMutation
  >(
    updatePolicyMutation,
  );
  const [supported, setSupported] = createSignal(false);
  const [permission, setPermission] = createSignal<
    NotificationPermission | null
  >(
    null,
  );
  const [subscribed, setSubscribed] = createSignal(false);
  const [endpoint, setEndpoint] = createSignal<string | null>(null);
  const [checking, setChecking] = createSignal(true);
  const [policy, setPolicy] = createSignal<
    PushNotificationPreviewPolicy | undefined
  >(undefined);

  const effectivePolicy = () =>
    policy() ??
      (account()?.pushNotificationPreviewPolicy as
        | PushNotificationPreviewPolicy
        | undefined) ??
      "PUBLIC_ONLY";
  const busy = () => registering() || unregistering() || checking();
  const canUsePush = () => supported() && props.vapidPublicKey != null;

  async function refreshSubscriptionState() {
    setChecking(true);
    setSupported(isWebPushSupported());
    setPermission(getNotificationPermission());
    if (!isWebPushSupported()) {
      setSubscribed(false);
      setEndpoint(null);
      setChecking(false);
      return;
    }
    try {
      const subscription = props.vapidPublicKey == null
        ? null
        : await getReusableWebPushSubscriptionData(props.vapidPublicKey);
      setSubscribed(subscription != null);
      setEndpoint(subscription?.endpoint ?? null);
      setPermission(getNotificationPermission());
      if (subscription != null) {
        registerSubscription(subscription, { silent: true });
      }
    } catch (error) {
      console.error(error);
      cleanupBrowserSubscription();
      setSubscribed(false);
      setEndpoint(null);
    } finally {
      setChecking(false);
    }
  }

  onMount(() => {
    void refreshSubscriptionState();
  });

  function cleanupBrowserSubscription() {
    void unsubscribeFromWebPush().catch((error) => console.error(error));
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
            setEndpoint(null);
          } else {
            setSubscribed(false);
            setEndpoint(null);
          }
          return;
        }
        setSubscribed(true);
        setEndpoint(subscription.endpoint);
        setPermission(getNotificationPermission());
        if (!options.silent) {
          showToast({
            title: t`Browser notifications enabled`,
            description:
              t`New notifications can now appear even when Hackers' Pub is not open.`,
            variant: "success",
          });
        }
      },
      onError(error) {
        console.error(error);
        if (!options.silent) {
          cleanupBrowserSubscription();
          setSubscribed(false);
          setEndpoint(null);
        } else {
          setSubscribed(false);
          setEndpoint(null);
        }
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
      showToast({
        title: t`Failed to enable browser notifications`,
        description: error instanceof Error ? error.message : undefined,
        variant: "error",
      });
      setPermission(getNotificationPermission());
    }
  }

  async function disablePush() {
    try {
      const removedEndpoint = await unsubscribeFromWebPush();
      const targetEndpoint = removedEndpoint ?? endpoint();
      setSubscribed(false);
      setEndpoint(null);
      setPermission(getNotificationPermission());
      if (targetEndpoint == null) {
        return;
      }
      unregisterTarget({
        variables: { endpoint: targetEndpoint },
        onCompleted(response) {
          if (
            response.unregisterPushNotificationTarget?.__typename !==
              "UnregisterPushNotificationTargetPayload"
          ) {
            showToast({
              title: t`Failed to disable browser notifications`,
              variant: "error",
            });
            return;
          }
          showToast({
            title: t`Browser notifications disabled`,
            variant: "success",
          });
        },
        onError(error) {
          console.error(error);
          showToast({
            title: t`Failed to disable browser notifications`,
            description: import.meta.env.DEV ? error.message : undefined,
            variant: "error",
          });
        },
      });
    } catch (error) {
      showToast({
        title: t`Failed to disable browser notifications`,
        description: error instanceof Error ? error.message : undefined,
        variant: "error",
      });
    }
  }

  function savePolicy(nextPolicy: PushNotificationPreviewPolicy) {
    const current = account();
    if (current == null) return;
    setPolicy(nextPolicy);
    updatePolicy({
      variables: {
        id: current.id,
        policy: nextPolicy,
      },
      onCompleted() {
        showToast({
          title: t`Push notification privacy updated`,
          variant: "success",
        });
      },
      onError(error) {
        console.error(error);
        setPolicy(
          current
            .pushNotificationPreviewPolicy as PushNotificationPreviewPolicy,
        );
        showToast({
          title: t`Failed to update push notification privacy`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t`Browser notifications`}</CardTitle>
        <CardDescription>
          {t`Receive notifications immediately through this browser, even when this tab is closed.`}
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-5">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="space-y-1">
            <p class="text-sm font-medium">
              <Show
                when={canUsePush()}
                fallback={t`Browser notifications are not available.`}
              >
                <Show
                  when={subscribed()}
                  fallback={t`Browser notifications are off.`}
                >
                  {t`Browser notifications are on.`}
                </Show>
              </Show>
            </p>
            <p class="text-sm text-muted-foreground">
              <Show
                when={props.vapidPublicKey != null}
                fallback={t`This server has not configured Web Push yet.`}
              >
                <Show
                  when={permission() !== "denied"}
                  fallback={t`Notifications are blocked in your browser settings.`}
                >
                  {t`Clicking a notification opens your notifications page.`}
                </Show>
              </Show>
            </p>
          </div>
          <div class="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void refreshSubscriptionState()}
              disabled={checking()}
            >
              <IconRefreshCw class="size-4" />
              {checking() ? t`Checking…` : t`Check again`}
            </Button>
            <Show
              when={subscribed()}
              fallback={
                <Button
                  type="button"
                  onClick={() => void enablePush()}
                  disabled={!canUsePush() || permission() === "denied" ||
                    busy()}
                >
                  <IconBell class="size-4" />
                  {registering() ? t`Enabling…` : t`Enable`}
                </Button>
              }
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => void disablePush()}
                disabled={busy()}
              >
                <IconBellOff class="size-4" />
                {unregistering() ? t`Disabling…` : t`Disable`}
              </Button>
            </Show>
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <Label>{t`Notification preview privacy`}</Label>
          <PushNotificationPreviewPolicySelect
            value={effectivePolicy()}
            onChange={savePolicy}
            disabled={updatingPolicy()}
          />
          <p class="text-sm text-muted-foreground">
            {t`Choose whether push notifications may include post excerpts. Generic notification text is used when previews are hidden.`}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
