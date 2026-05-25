import { getLogger } from "@logtape/logtape";
import { and, eq } from "drizzle-orm";
import webPush from "web-push";
import type { Database } from "./db.ts";
import {
  buildPushNotificationPayload,
  type PushNotificationPayloadOptions,
} from "./push-notification.ts";
import {
  deleteStalePushNotificationTargets,
  pushTargetHasEndpoint,
} from "./push.ts";
import { pushNotificationTargetTable } from "./schema.ts";

const logger = getLogger(["hackerspub", "models", "webpush"]);

interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

type WebPushSender = (
  subscription: WebPushSubscription,
  payload: string,
) => Promise<unknown>;

let senderForTesting: WebPushSender | undefined;
let configForTesting: WebPushConfig | undefined;
let cachedEnvConfig: WebPushConfig | null | undefined;

function readEnvConfig(): WebPushConfig | null {
  if (cachedEnvConfig !== undefined) return cachedEnvConfig;

  const publicKey = Deno.env.get("WEB_PUSH_VAPID_PUBLIC_KEY")?.trim() ?? "";
  const privateKey = Deno.env.get("WEB_PUSH_VAPID_PRIVATE_KEY")?.trim() ?? "";
  const subject = Deno.env.get("WEB_PUSH_VAPID_SUBJECT")?.trim() ?? "";

  if (publicKey === "" && privateKey === "" && subject === "") {
    logger.debug(
      "Web Push integration is disabled because WEB_PUSH_VAPID_* environment variables are not set.",
    );
    return cachedEnvConfig = null;
  }
  if (publicKey === "" || privateKey === "" || subject === "") {
    logger.warning(
      "Web Push integration is disabled because WEB_PUSH_VAPID_* environment variables are incomplete.",
    );
    return cachedEnvConfig = null;
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    logger.warning(
      "Web Push integration is disabled because WEB_PUSH_VAPID_SUBJECT must be a mailto: address or an https:// URL.",
    );
    return cachedEnvConfig = null;
  }

  return cachedEnvConfig = { publicKey, privateKey, subject };
}

export function getWebPushVapidPublicKey(): string | null {
  return (configForTesting ?? readEnvConfig())?.publicKey ?? null;
}

async function sendWebPush(
  config: WebPushConfig,
  subscription: WebPushSubscription,
  payload: string,
): Promise<unknown> {
  if (senderForTesting != null) {
    return await senderForTesting(subscription, payload);
  }
  return await webPush.sendNotification(subscription, payload, {
    vapidDetails: {
      subject: config.subject,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
    },
  });
}

function getStatusCode(error: unknown): number | undefined {
  return typeof error === "object" && error != null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;
}

function getEndpointSuffix(endpoint: string): string {
  return endpoint.length <= 16 ? endpoint : endpoint.slice(-16);
}

function getErrorName(error: unknown): string | undefined {
  return typeof error === "object" && error != null &&
      "name" in error &&
      typeof error.name === "string"
    ? error.name
    : undefined;
}

export function setWebPushSenderForTesting(
  sender: WebPushSender | undefined,
): void {
  senderForTesting = sender;
}

export function setWebPushConfigForTesting(
  config: WebPushConfig | undefined,
): void {
  configForTesting = config;
  cachedEnvConfig = undefined;
}

export function clearWebPushEnvConfigCacheForTesting(): void {
  cachedEnvConfig = undefined;
}

export async function sendWebPushNotification(
  db: Database,
  options: PushNotificationPayloadOptions,
): Promise<void> {
  const config = configForTesting ?? readEnvConfig();
  if (config == null) return;

  const targets = (await db.select({
    endpoint: pushNotificationTargetTable.endpoint,
    p256dh: pushNotificationTargetTable.p256dh,
    auth: pushNotificationTargetTable.auth,
    expirationTime: pushNotificationTargetTable.expirationTime,
  }).from(pushNotificationTargetTable)
    .where(
      and(
        eq(pushNotificationTargetTable.accountId, options.accountId),
        eq(pushNotificationTargetTable.service, "web_push"),
      ),
    )).filter(pushTargetHasEndpoint);
  if (targets.length < 1) return;

  const payload = JSON.stringify(
    await buildPushNotificationPayload(db, options),
  );
  const staleEndpoints = new Set<string>();

  await Promise.allSettled(
    targets.map(async (target) => {
      const subscription = {
        endpoint: target.endpoint,
        expirationTime: target.expirationTime?.getTime() ?? null,
        keys: {
          p256dh: target.p256dh,
          auth: target.auth,
        },
      };

      try {
        await sendWebPush(config, subscription, payload);
      } catch (error) {
        const statusCode = getStatusCode(error);
        const errorName = getErrorName(error);
        logger.warning(
          "Web Push send failed for account {accountId}, endpoint suffix {endpointSuffix}: {statusCode} {errorName}",
          {
            accountId: options.accountId,
            endpointSuffix: getEndpointSuffix(target.endpoint),
            statusCode,
            errorName,
          },
        );
        if (statusCode === 404 || statusCode === 410) {
          staleEndpoints.add(target.endpoint);
        }
      }
    }),
  );

  await deleteStalePushNotificationTargets(
    db,
    options.accountId,
    "web_push",
    [...staleEndpoints],
  );
}
