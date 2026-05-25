export interface WebPushSubscriptionData {
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: string | null;
}

export type WebPushErrorCode =
  | "incomplete-subscription"
  | "invalid-vapid-public-key"
  | "permission-denied"
  | "permission-dismissed"
  | "unsupported";

export class WebPushError extends Error {
  constructor(
    public readonly code: WebPushErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "WebPushError";
  }
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
    throw new WebPushError("unsupported");
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

export async function getReusableWebPushSubscriptionData(
  vapidPublicKey: string,
): Promise<WebPushSubscriptionData | null> {
  if (!isWebPushSupported()) return null;
  const registration = await getWebPushRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription == null) return null;

  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
  if (
    !subscriptionUsesApplicationServerKey(subscription, applicationServerKey)
  ) {
    await subscription.unsubscribe();
    return null;
  }

  return serializeWebPushSubscription(subscription);
}

export async function subscribeToWebPush(
  vapidPublicKey: string,
): Promise<WebPushSubscriptionData> {
  if (!isWebPushSupported()) {
    throw new WebPushError("unsupported");
  }
  if (Notification.permission === "denied") {
    dispatchPermissionChange();
    throw new WebPushError("permission-denied");
  }
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    dispatchPermissionChange();
    if (permission !== "granted") {
      throw new WebPushError("permission-dismissed");
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
    throw new WebPushError("incomplete-subscription");
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
  try {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch (error) {
    throw new WebPushError("invalid-vapid-public-key", { cause: error });
  }
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
  if (currentKey == null) return false;
  const currentBytes = new Uint8Array(currentKey);
  if (currentBytes.byteLength !== applicationServerKey.byteLength) return false;
  return currentBytes.every((byte, index) =>
    byte === applicationServerKey[index]
  );
}

function dispatchPermissionChange(): void {
  window.dispatchEvent(new CustomEvent(WEB_PUSH_PERMISSION_CHANGE_EVENT));
}
