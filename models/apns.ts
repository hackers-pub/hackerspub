import { getLogger } from "@logtape/logtape";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { ApnsClient, Errors, Host, Notification } from "apns2";
import type { Database } from "./db.ts";
import {
  type ApnsDeviceToken,
  apnsDeviceTokenTable,
  type CustomEmoji,
  type NotificationType,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "apns"]);
const APNS_DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT = 20;

interface ApnsConfig {
  teamId: string;
  keyId: string;
  signingKey: string;
  defaultTopic: string;
  host?: string;
}

export interface ApnsNotificationOptions {
  accountId: Uuid;
  notificationId: Uuid;
  type: NotificationType;
  actorId: Uuid;
  postId?: Uuid | null;
  emoji?: string | CustomEmoji | null;
}

let apnsClient: ApnsClient | null | undefined;
let hasLoggedApnsDisabled = false;

function getEnvString(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value == null || value === "" ? undefined : value;
}

function resolveApnsHost(host: string | undefined): string | undefined {
  if (host == null) return undefined;
  switch (host.toLowerCase()) {
    case "development":
    case "sandbox":
      return Host.development;
    case "production":
    case "prod":
      return Host.production;
    default:
      return host;
  }
}

function getApnsConfig(): ApnsConfig | null {
  const teamId = getEnvString("APNS_TEAM_ID");
  const keyId = getEnvString("APNS_KEY_ID");
  const signingKey = getEnvString("APNS_SIGNING_KEY");
  const defaultTopic = getEnvString("APNS_DEFAULT_TOPIC");
  if (
    teamId == null || keyId == null || signingKey == null ||
    defaultTopic == null
  ) {
    return null;
  }
  return {
    teamId,
    keyId,
    signingKey: signingKey.replaceAll("\\n", "\n"),
    defaultTopic,
    host: resolveApnsHost(getEnvString("APNS_HOST")),
  };
}

function getApnsClient(): ApnsClient | null {
  if (apnsClient !== undefined) return apnsClient;
  const config = getApnsConfig();
  if (config == null) {
    if (!hasLoggedApnsDisabled) {
      logger.debug(
        "APNS integration is disabled because APNS_* environment variables are incomplete.",
      );
      hasLoggedApnsDisabled = true;
    }
    apnsClient = null;
    return null;
  }
  try {
    apnsClient = new ApnsClient({
      team: config.teamId,
      keyId: config.keyId,
      signingKey: config.signingKey,
      defaultTopic: config.defaultTopic,
      host: config.host,
    });
    return apnsClient;
  } catch (error) {
    logger.error("Failed to initialize APNS client: {error}", { error });
    apnsClient = null;
    return null;
  }
}

export function normalizeApnsDeviceToken(deviceToken: string): string | null {
  const normalized = deviceToken.trim().replaceAll(/[<>\s]/g, "").toLowerCase();
  return APNS_DEVICE_TOKEN_PATTERN.test(normalized) ? normalized : null;
}

export async function registerApnsDeviceToken(
  db: Database,
  accountId: Uuid,
  deviceToken: string,
): Promise<ApnsDeviceToken | undefined> {
  const normalized = normalizeApnsDeviceToken(deviceToken);
  if (normalized == null) return undefined;

  const existingToken = await db.query.apnsDeviceTokenTable.findFirst({
    columns: { accountId: true },
    where: { deviceToken: normalized },
  });
  if (existingToken?.accountId !== accountId) {
    const tokenCounts = await db.select({ count: count() })
      .from(apnsDeviceTokenTable)
      .where(eq(apnsDeviceTokenTable.accountId, accountId));
    const tokenCount = Number(tokenCounts[0]?.count ?? 0);
    if (tokenCount >= MAX_APNS_DEVICE_TOKENS_PER_ACCOUNT) {
      return undefined;
    }
  }

  const rows = await db.insert(apnsDeviceTokenTable)
    .values({
      accountId,
      deviceToken: normalized,
    })
    .onConflictDoUpdate({
      target: apnsDeviceTokenTable.deviceToken,
      set: {
        accountId,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning();
  return rows[0];
}

export async function unregisterApnsDeviceToken(
  db: Database,
  accountId: Uuid,
  deviceToken: string,
): Promise<boolean> {
  const normalized = normalizeApnsDeviceToken(deviceToken);
  if (normalized == null) return false;
  const rows = await db.delete(apnsDeviceTokenTable)
    .where(
      and(
        eq(apnsDeviceTokenTable.accountId, accountId),
        eq(apnsDeviceTokenTable.deviceToken, normalized),
      ),
    )
    .returning({ deviceToken: apnsDeviceTokenTable.deviceToken });
  return rows.length > 0;
}

function getApnsAlert(
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

export async function sendApnsNotification(
  db: Database,
  options: ApnsNotificationOptions,
): Promise<void> {
  try {
    const client = getApnsClient();
    if (client == null) return;
    const tokens = await db.query.apnsDeviceTokenTable.findMany({
      columns: { deviceToken: true },
      where: { accountId: options.accountId },
    });
    if (tokens.length < 1) return;

    const emojiText = typeof options.emoji === "string"
      ? options.emoji
      : options.emoji?.name ?? null;

    const notifications = tokens.map(({ deviceToken }) =>
      new Notification(deviceToken, {
        alert: getApnsAlert(options.type, options.emoji),
        threadId: "notifications",
        collapseId: `notifications-${options.accountId}`,
        data: {
          notificationId: options.notificationId,
          type: options.type,
          actorId: options.actorId,
          postId: options.postId ?? null,
          emoji: emojiText,
        },
      })
    );

    let results: Awaited<ReturnType<ApnsClient["sendMany"]>>;
    try {
      results = await client.sendMany(notifications);
    } catch (error) {
      logger.error(
        "Failed to send APNS notifications for account {accountId}: {error}",
        {
          accountId: options.accountId,
          error,
        },
      );
      return;
    }

    const staleTokens = new Set<string>();
    for (const result of results) {
      if (!("error" in result)) continue;
      const { error } = result;
      const deviceToken = error.notification.deviceToken;
      logger.warn(
        "APNS send failed for account {accountId}, token suffix {deviceTokenSuffix}: {reason}",
        {
          accountId: options.accountId,
          deviceTokenSuffix: getDeviceTokenSuffix(deviceToken),
          reason: error.reason,
        },
      );
      if (
        error.reason === Errors.badDeviceToken ||
        error.reason === Errors.deviceTokenNotForTopic ||
        error.reason === Errors.unregistered
      ) {
        staleTokens.add(deviceToken);
      }
    }

    if (staleTokens.size < 1) return;
    await db.delete(apnsDeviceTokenTable)
      .where(
        and(
          eq(apnsDeviceTokenTable.accountId, options.accountId),
          inArray(apnsDeviceTokenTable.deviceToken, [...staleTokens]),
        ),
      );
  } catch (error) {
    logger.error(
      "Unexpected APNS error for account {accountId}: {error}",
      {
        accountId: options.accountId,
        error,
      },
    );
  }
}
