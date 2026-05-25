export interface WebPushSubscriptionData {
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: string | null;
}

export const WEB_PUSH_PERMISSION_CHANGE_EVENT =
  "hackerspub:web-push-permission-change";

export function isWebPushSupported(): boolean {
  return typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext;
}

export function getNotificationPermission(): NotificationPermission | null {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return null;
  }
  return Notification.permission;
}

export async function getWebPushRegistration(): Promise<
  ServiceWorkerRegistration
> {
  if (!isWebPushSupported()) {
    throw new Error("Web Push is not supported in this browser.");
  }
  return await navigator.serviceWorker.register("/web-push-sw.js", {
    scope: "/",
  });
}

export async function getExistingWebPushSubscription(): Promise<
  PushSubscription | null
> {
  if (!isWebPushSupported()) return null;
  const registration = await getWebPushRegistration();
  return await registration.pushManager.getSubscription();
}

export async function subscribeToWebPush(
  vapidPublicKey: string,
): Promise<WebPushSubscriptionData> {
  if (!isWebPushSupported()) {
    throw new Error("Web Push is not supported in this browser.");
  }
  if (Notification.permission === "denied") {
    dispatchPermissionChange();
    throw new Error("Notifications are blocked for this site.");
  }
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    dispatchPermissionChange();
    if (permission !== "granted") {
      throw new Error("Notification permission was not granted.");
    }
  }

  const registration = await getWebPushRegistration();
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (
    subscription != null &&
    !subscriptionUsesApplicationServerKey(subscription, applicationServerKey)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription = subscription ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  return serializeWebPushSubscription(subscription);
}

export async function unsubscribeFromWebPush(): Promise<string | null> {
  const subscription = await getExistingWebPushSubscription();
  if (subscription == null) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}

export function serializeWebPushSubscription(
  subscription: PushSubscription,
): WebPushSubscriptionData {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh ??
    arrayBufferToBase64Url(subscription.getKey("p256dh"));
  const auth = json.keys?.auth ?? arrayBufferToBase64Url(subscription.getKey(
    "auth",
  ));

  if (json.endpoint == null || p256dh == null || auth == null) {
    throw new Error("Browser did not provide a complete push subscription.");
  }

  return {
    endpoint: json.endpoint,
    p256dh,
    auth,
    expirationTime: subscription.expirationTime == null
      ? null
      : new Date(subscription.expirationTime).toISOString(),
  };
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function arrayBufferToBase64Url(
  value: ArrayBuffer | null,
): string | undefined {
  if (value == null) return undefined;
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function subscriptionUsesApplicationServerKey(
  subscription: PushSubscription,
  applicationServerKey: Uint8Array<ArrayBuffer>,
): boolean {
  const currentKey = subscription.options.applicationServerKey;
  if (currentKey == null) return true;
  const currentBytes = new Uint8Array(currentKey);
  if (currentBytes.byteLength !== applicationServerKey.byteLength) return false;
  return currentBytes.every((byte, index) =>
    byte === applicationServerKey[index]
  );
}

function dispatchPermissionChange(): void {
  window.dispatchEvent(new CustomEvent(WEB_PUSH_PERMISSION_CHANGE_EVENT));
}
