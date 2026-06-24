import process from "node:process";
import { getLogger } from "@logtape/logtape";
import { and, eq } from "drizzle-orm";
import type { Database } from "./db.ts";
import {
  type CustomEmoji,
  type NotificationType,
  pushNotificationTargetTable,
} from "./schema.ts";
import {
  deleteStalePushNotificationTargets,
  MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE,
  pushTargetHasToken,
  registerPushNotificationTarget,
  unregisterPushNotificationTarget,
} from "./push.ts";
import type { Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "fcm"]);
export const MAX_FCM_DEVICE_TOKENS_PER_ACCOUNT =
  MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE;
export { normalizeFcmDeviceToken } from "./push.ts";

interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface FcmNotificationOptions {
  accountId: Uuid;
  notificationId: Uuid;
  type: NotificationType;
  actorId: Uuid;
  postId?: Uuid | null;
  emoji?: string | CustomEmoji | null;
}

let cachedServiceAccount: FcmServiceAccount | null | undefined;
let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let hasLoggedFcmDisabled = false;

export function resetFcmStateForTesting(): void {
  cachedServiceAccount = undefined;
  cachedAccessToken = null;
  hasLoggedFcmDisabled = false;
}

function getEnvString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value == null || value === "" ? undefined : value;
}

function getServiceAccount(): FcmServiceAccount | null {
  if (cachedServiceAccount !== undefined) return cachedServiceAccount;
  const encoded = getEnvString("GOOGLE_SERVICES_JSON_BASE64");
  if (encoded == null) {
    if (!hasLoggedFcmDisabled) {
      logger.debug(
        "FCM integration is disabled because GOOGLE_SERVICES_JSON_BASE64 is not set.",
      );
      hasLoggedFcmDisabled = true;
    }
    cachedServiceAccount = null;
    return null;
  }
  let keyJson: string;
  try {
    keyJson = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
    );
  } catch (error) {
    logger.error(
      "Failed to base64-decode GOOGLE_SERVICES_JSON_BASE64: {error}",
      { error },
    );
    cachedServiceAccount = null;
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(keyJson);
  } catch (error) {
    logger.error("Failed to parse GOOGLE_SERVICES_JSON_BASE64: {error}", {
      error,
    });
    cachedServiceAccount = null;
    return null;
  }

  const fields = (parsed ?? {}) as Record<string, unknown>;
  const projectId = fields.project_id;
  const clientEmail = fields.client_email;
  const privateKey = fields.private_key;
  const missing = (
    [
      ["project_id", projectId],
      ["client_email", clientEmail],
      ["private_key", privateKey],
    ] as const
  )
    .filter(([, value]) => typeof value !== "string" || value.trim() === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    logger.error(
      "GOOGLE_SERVICES_JSON_BASE64 is missing required service account " +
        "field(s): {missing}. It must be a Firebase Admin SDK service account " +
        "key (containing `private_key`, `client_email`, and `project_id`), " +
        "not an Android `google-services.json` client config. FCM push " +
        "notifications are disabled.",
      { missing },
    );
    cachedServiceAccount = null;
    return null;
  }

  cachedServiceAccount = {
    projectId: projectId as string,
    clientEmail: clientEmail as string,
    privateKey: privateKey as string,
  };
  return cachedServiceAccount;
}

async function getAccessToken(): Promise<string | null> {
  if (
    cachedAccessToken != null &&
    cachedAccessToken.expiresAt > Date.now() + 60000
  ) {
    return cachedAccessToken.token;
  }

  const sa = getServiceAccount();
  if (sa == null) return null;

  try {
    const now = Math.floor(Date.now() / 1000);
    const toBase64Url = (str: string) =>
      btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = toBase64Url(JSON.stringify({
      iss: sa.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));
    const unsignedToken = `${header}.${payload}`;

    const keyData = sa.privateKey
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s/g, "");
    const binaryKey = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(unsignedToken),
    );
    const sig = toBase64Url(
      String.fromCharCode(...new Uint8Array(signature)),
    );

    const jwt = `${unsignedToken}.${sig}`;
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.error("Failed to get FCM access token: {status} {body}", {
        status: resp.status,
        body,
      });
      return null;
    }

    const data = await resp.json() as {
      access_token: string;
      expires_in: number;
    };
    cachedAccessToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };
    return cachedAccessToken.token;
  } catch (error) {
    logger.error("Failed to get FCM access token: {error}", { error });
    return null;
  }
}

export async function registerFcmDeviceToken(
  db: Database,
  accountId: Uuid,
  deviceToken: string,
): ReturnType<typeof registerPushNotificationTarget> {
  return registerPushNotificationTarget(db, accountId, {
    service: "fcm",
    token: deviceToken,
  });
}

export async function unregisterFcmDeviceToken(
  db: Database,
  accountId: Uuid,
  deviceToken: string,
): Promise<boolean> {
  return unregisterPushNotificationTarget(db, accountId, {
    service: "fcm",
    token: deviceToken,
  });
}

function getFcmAlert(
  type: NotificationType,
  emoji?: string | CustomEmoji | null,
): string {
  switch (type) {
    case "follow":
      return "You have a new follower.";
    case "mention":
      return "You were mentioned in a post.";
    case "reply":
      return "You received a reply.";
    case "share":
      return "Your post was shared.";
    case "quote":
      return "Your post was quoted.";
    case "shared_post_updated":
      return "A post you shared was updated.";
    case "quoted_post_updated":
      return "A post you quoted was updated.";
    case "poll_ended":
      return "A poll ended.";
    case "organization_invitation":
      return "You have an organization invitation.";
    case "organization_conversion_request":
      return "You have an organization conversion request.";
    case "react": {
      const emojiText = typeof emoji === "string" ? emoji : emoji?.name;
      return emojiText == null
        ? "Someone reacted to your post."
        : `Someone reacted ${emojiText} to your post.`;
    }
  }
}

function getDeviceTokenSuffix(deviceToken: string): string {
  return deviceToken.length <= 8 ? deviceToken : deviceToken.slice(-8);
}

export async function sendFcmNotification(
  db: Database,
  options: FcmNotificationOptions,
): Promise<void> {
  try {
    const sa = getServiceAccount();
    if (sa == null) return;

    const accessToken = await getAccessToken();
    if (accessToken == null) return;

    const tokens = (await db.select({
      token: pushNotificationTargetTable.token,
    })
      .from(pushNotificationTargetTable)
      .where(
        and(
          eq(pushNotificationTargetTable.accountId, options.accountId),
          eq(pushNotificationTargetTable.service, "fcm"),
        ),
      )).filter(pushTargetHasToken);
    if (tokens.length < 1) return;

    const emojiText = typeof options.emoji === "string"
      ? options.emoji
      : options.emoji?.name ?? null;

    const staleTokens = new Set<string>();

    await Promise.allSettled(
      tokens.map(async ({ token }) => {
        try {
          const resp = await fetch(
            `https://fcm.googleapis.com/v1/projects/${sa.projectId}/messages:send`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                message: {
                  token,
                  data: {
                    notificationId: options.notificationId,
                    type: options.type,
                    actorId: options.actorId,
                    postId: options.postId ?? "",
                    emoji: emojiText ?? "",
                    alert: getFcmAlert(options.type, options.emoji),
                  },
                },
              }),
            },
          );

          if (!resp.ok) {
            const body = await resp.json().catch(() => ({})) as {
              error?: {
                status?: string;
                details?: Array<{ errorCode?: string }>;
              };
            };
            const errorCode = body.error?.details?.[0]?.errorCode ??
              body.error?.status;
            logger.warn(
              "FCM send failed for account {accountId}, token suffix {deviceTokenSuffix}: {status} {errorCode}",
              {
                accountId: options.accountId,
                deviceTokenSuffix: getDeviceTokenSuffix(token),
                status: resp.status,
                errorCode,
              },
            );
            if (errorCode === "UNREGISTERED") {
              staleTokens.add(token);
            }
          }
        } catch (error) {
          logger.warn(
            "FCM send error for account {accountId}, token suffix {deviceTokenSuffix}: {error}",
            {
              accountId: options.accountId,
              deviceTokenSuffix: getDeviceTokenSuffix(token),
              error,
            },
          );
        }
      }),
    );

    if (staleTokens.size < 1) return;
    await deleteStalePushNotificationTargets(
      db,
      options.accountId,
      "fcm",
      [...staleTokens],
    );
  } catch (error) {
    logger.error(
      "Unexpected FCM error for account {accountId}: {error}",
      {
        accountId: options.accountId,
        error,
      },
    );
  }
}
