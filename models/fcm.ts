import process from "node:process";
import { getLogger } from "@logtape/logtape";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import {
  type CustomEmoji,
  type FcmDeviceToken,
  fcmDeviceTokenTable,
  type NotificationType,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "fcm"]);
export const MAX_FCM_DEVICE_TOKENS_PER_ACCOUNT = 20;

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
  try {
    const parsed = JSON.parse(keyJson);
    cachedServiceAccount = {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
    return cachedServiceAccount;
  } catch (error) {
    logger.error("Failed to parse GOOGLE_SERVICES_JSON_BASE64: {error}", {
      error,
    });
    cachedServiceAccount = null;
    return null;
  }
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
): Promise<FcmDeviceToken | undefined> {
  const trimmed = deviceToken.trim();
  if (trimmed.length < 1) return undefined;

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from "account" where id = ${accountId} for update`,
    );

    const existingToken = await tx.query.fcmDeviceTokenTable.findFirst({
      columns: { accountId: true },
      where: { deviceToken: trimmed },
    });
    if (existingToken?.accountId !== accountId) {
      const tokenCounts = await tx.select({ count: count() })
        .from(fcmDeviceTokenTable)
        .where(eq(fcmDeviceTokenTable.accountId, accountId));
      const tokenCount = Number(tokenCounts[0]?.count ?? 0);
      if (tokenCount >= MAX_FCM_DEVICE_TOKENS_PER_ACCOUNT) {
        const oldestTokens = await tx.select({
          deviceToken: fcmDeviceTokenTable.deviceToken,
        })
          .from(fcmDeviceTokenTable)
          .where(eq(fcmDeviceTokenTable.accountId, accountId))
          .orderBy(
            fcmDeviceTokenTable.updated,
            fcmDeviceTokenTable.created,
          )
          .limit(1);
        const oldestToken = oldestTokens[0]?.deviceToken;
        if (oldestToken == null) return undefined;
        await tx.delete(fcmDeviceTokenTable)
          .where(
            and(
              eq(fcmDeviceTokenTable.accountId, accountId),
              eq(fcmDeviceTokenTable.deviceToken, oldestToken),
            ),
          );
      }
    }

    const rows = await tx.insert(fcmDeviceTokenTable)
      .values({
        accountId,
        deviceToken: trimmed,
      })
      .onConflictDoUpdate({
        target: fcmDeviceTokenTable.deviceToken,
        set: {
          accountId,
          updated: sql`CURRENT_TIMESTAMP`,
        },
      })
      .returning();
    return rows[0];
  });
}

export async function unregisterFcmDeviceToken(
  db: Database,
  accountId: Uuid,
  deviceToken: string,
): Promise<boolean> {
  const trimmed = deviceToken.trim();
  if (trimmed.length < 1) return false;
  const rows = await db.delete(fcmDeviceTokenTable)
    .where(
      and(
        eq(fcmDeviceTokenTable.accountId, accountId),
        eq(fcmDeviceTokenTable.deviceToken, trimmed),
      ),
    )
    .returning({ deviceToken: fcmDeviceTokenTable.deviceToken });
  return rows.length > 0;
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

    const tokens = await db.query.fcmDeviceTokenTable.findMany({
      columns: { deviceToken: true },
      where: { accountId: options.accountId },
    });
    if (tokens.length < 1) return;

    const emojiText = typeof options.emoji === "string"
      ? options.emoji
      : options.emoji?.name ?? null;

    const staleTokens = new Set<string>();

    await Promise.allSettled(
      tokens.map(async ({ deviceToken }) => {
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
                  token: deviceToken,
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
                deviceTokenSuffix: getDeviceTokenSuffix(deviceToken),
                status: resp.status,
                errorCode,
              },
            );
            if (errorCode === "UNREGISTERED") {
              staleTokens.add(deviceToken);
            }
          }
        } catch (error) {
          logger.warn(
            "FCM send error for account {accountId}, token suffix {deviceTokenSuffix}: {error}",
            {
              accountId: options.accountId,
              deviceTokenSuffix: getDeviceTokenSuffix(deviceToken),
              error,
            },
          );
        }
      }),
    );

    if (staleTokens.size < 1) return;
    await db.delete(fcmDeviceTokenTable)
      .where(
        and(
          eq(fcmDeviceTokenTable.accountId, options.accountId),
          inArray(fcmDeviceTokenTable.deviceToken, [...staleTokens]),
        ),
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
