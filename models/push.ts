import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { isSSRFSafeURL } from "ssrfcheck";
import type { Database } from "./db.ts";
import {
  type NewPushNotificationTarget,
  type PushNotificationService,
  type PushNotificationTarget,
  pushNotificationTargetTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const APNS_DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE = 20;

export interface WebPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime?: Date | null;
}

export interface RegisterPushNotificationTargetInput {
  service: PushNotificationService;
  token?: string | null;
  subscription?: WebPushSubscriptionInput | null;
}

export interface UnregisterPushNotificationTargetInput {
  service: PushNotificationService;
  token?: string | null;
  endpoint?: string | null;
}

export function normalizeApnsDeviceToken(deviceToken: string): string | null {
  const normalized = deviceToken.trim().replaceAll(/[<>\s]/g, "").toLowerCase();
  return APNS_DEVICE_TOKEN_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeFcmDeviceToken(deviceToken: string): string | null {
  const trimmed = deviceToken.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeWebPushEndpoint(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return isSafeWebPushEndpoint(url) ? trimmed : null;
}

function isSafeWebPushEndpoint(url: URL): boolean {
  const mappedIpv4 = getIpv4FromMappedIpv6Host(url.hostname);
  if (
    mappedIpv4 != null &&
    !isSSRFSafeURL(`https://${mappedIpv4}/`, { autoPrependProtocol: false })
  ) {
    return false;
  }
  return isSSRFSafeURL(url.href, { autoPrependProtocol: false });
}

function getIpv4FromMappedIpv6Host(hostname: string): string | null {
  const normalized = hostname.toLowerCase();
  const prefix = "[::ffff:";
  if (!normalized.startsWith(prefix) || !normalized.endsWith("]")) {
    return null;
  }

  const suffix = normalized.slice(prefix.length, -1);
  if (suffix.includes(".")) return getIpv4FromDottedDecimal(suffix);

  const words = suffix.split(":");
  if (words.length !== 2) return null;

  if (words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;

  const values = words.map((word) => Number.parseInt(word, 16));
  if (values.some((value) => value > 0xffff)) return null;

  const [high, low] = values as [number, number];
  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}

function getIpv4FromDottedDecimal(text: string): string | null {
  const octets = text.split(".");
  if (octets.length !== 4) return null;

  const values = octets.map((octet) => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(octet)) return null;
    const value = Number.parseInt(octet, 10);
    return value <= 255 ? value : null;
  });
  return values.some((value) => value == null) ? null : values.join(".");
}

export function normalizeWebPushKey(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed === "" || !BASE64URL_PATTERN.test(trimmed)) return null;
  try {
    const padding = "=".repeat((4 - trimmed.length % 4) % 4);
    atob((trimmed + padding).replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  return trimmed;
}

function normalizeWebPushSubscription(
  subscription: WebPushSubscriptionInput | null | undefined,
): WebPushSubscriptionInput | null {
  const endpoint = subscription?.endpoint == null
    ? null
    : normalizeWebPushEndpoint(subscription.endpoint);
  const p256dh = subscription?.p256dh == null
    ? null
    : normalizeWebPushKey(subscription.p256dh);
  const auth = subscription?.auth == null
    ? null
    : normalizeWebPushKey(subscription.auth);
  if (endpoint == null || p256dh == null || auth == null) return null;
  return {
    endpoint,
    p256dh,
    auth,
    expirationTime: subscription?.expirationTime ?? null,
  };
}

function buildTargetValues(
  accountId: Uuid,
  input: RegisterPushNotificationTargetInput,
): NewPushNotificationTarget | null {
  switch (input.service) {
    case "apns": {
      const token = input.token == null
        ? null
        : normalizeApnsDeviceToken(input.token);
      if (token == null) return null;
      return {
        id: generateUuidV7(),
        accountId,
        service: "apns",
        token,
      };
    }
    case "fcm": {
      const token = input.token == null
        ? null
        : normalizeFcmDeviceToken(input.token);
      if (token == null) return null;
      return {
        id: generateUuidV7(),
        accountId,
        service: "fcm",
        token,
      };
    }
    case "web_push": {
      const subscription = normalizeWebPushSubscription(input.subscription);
      if (subscription == null) return null;
      return {
        id: generateUuidV7(),
        accountId,
        service: "web_push",
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        expirationTime: subscription.expirationTime,
      };
    }
  }
}

function buildTargetWhere(values: NewPushNotificationTarget) {
  return values.service === "web_push"
    ? eq(pushNotificationTargetTable.endpoint, values.endpoint!)
    : and(
      eq(pushNotificationTargetTable.service, values.service),
      eq(pushNotificationTargetTable.token, values.token!),
    );
}

async function evictOldestTargetIfNeeded(
  db: Database,
  accountId: Uuid,
  service: PushNotificationService,
): Promise<void> {
  const tokenCounts = await db.select({ count: count() })
    .from(pushNotificationTargetTable)
    .where(
      and(
        eq(pushNotificationTargetTable.accountId, accountId),
        eq(pushNotificationTargetTable.service, service),
      ),
    );
  const tokenCount = Number(tokenCounts[0]?.count ?? 0);
  if (tokenCount < MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE) return;

  const oldestTargets = await db.select({
    id: pushNotificationTargetTable.id,
  })
    .from(pushNotificationTargetTable)
    .where(
      and(
        eq(pushNotificationTargetTable.accountId, accountId),
        eq(pushNotificationTargetTable.service, service),
      ),
    )
    .orderBy(
      pushNotificationTargetTable.updated,
      pushNotificationTargetTable.created,
      pushNotificationTargetTable.id,
    )
    .limit(1);
  const oldestTarget = oldestTargets[0]?.id;
  if (oldestTarget == null) return;
  await db.delete(pushNotificationTargetTable)
    .where(eq(pushNotificationTargetTable.id, oldestTarget));
}

export async function registerPushNotificationTarget(
  db: Database,
  accountId: Uuid,
  input: RegisterPushNotificationTargetInput,
): Promise<PushNotificationTarget | undefined> {
  const values = buildTargetValues(accountId, input);
  if (values == null) return undefined;

  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from "account" where id = ${accountId} for update`,
    );

    const existingTargets = await tx.select({
      accountId: pushNotificationTargetTable.accountId,
    })
      .from(pushNotificationTargetTable)
      .where(buildTargetWhere(values))
      .limit(1);
    const existingTarget = existingTargets[0];
    if (existingTarget?.accountId !== accountId) {
      await evictOldestTargetIfNeeded(tx, accountId, values.service);
    }

    const rows = await tx.insert(pushNotificationTargetTable)
      .values(values)
      .onConflictDoUpdate({
        target: values.service === "web_push"
          ? pushNotificationTargetTable.endpoint
          : [
            pushNotificationTargetTable.service,
            pushNotificationTargetTable.token,
          ],
        set: {
          accountId,
          token: values.token,
          endpoint: values.endpoint,
          p256dh: values.p256dh,
          auth: values.auth,
          expirationTime: values.expirationTime,
          updated: sql`CURRENT_TIMESTAMP`,
        },
        targetWhere: values.service === "web_push"
          ? isNotNull(pushNotificationTargetTable.endpoint)
          : isNotNull(pushNotificationTargetTable.token),
      })
      .returning();
    return rows[0];
  });
}

export async function unregisterPushNotificationTarget(
  db: Database,
  accountId: Uuid,
  input: UnregisterPushNotificationTargetInput,
): Promise<boolean> {
  let where;
  switch (input.service) {
    case "apns": {
      const token = input.token == null
        ? null
        : normalizeApnsDeviceToken(input.token);
      if (token == null) return false;
      where = and(
        eq(pushNotificationTargetTable.accountId, accountId),
        eq(pushNotificationTargetTable.service, "apns"),
        eq(pushNotificationTargetTable.token, token),
      );
      break;
    }
    case "fcm": {
      const token = input.token == null
        ? null
        : normalizeFcmDeviceToken(input.token);
      if (token == null) return false;
      where = and(
        eq(pushNotificationTargetTable.accountId, accountId),
        eq(pushNotificationTargetTable.service, "fcm"),
        eq(pushNotificationTargetTable.token, token),
      );
      break;
    }
    case "web_push": {
      const endpoint = input.endpoint?.trim();
      if (endpoint == null || endpoint === "") return false;
      where = and(
        eq(pushNotificationTargetTable.accountId, accountId),
        eq(pushNotificationTargetTable.service, "web_push"),
        eq(pushNotificationTargetTable.endpoint, endpoint),
      );
      break;
    }
  }

  const rows = await db.delete(pushNotificationTargetTable)
    .where(where)
    .returning({ id: pushNotificationTargetTable.id });
  return rows.length > 0;
}

export async function deleteStalePushNotificationTargets(
  db: Database,
  accountId: Uuid,
  service: PushNotificationService,
  values: string[],
): Promise<void> {
  if (values.length < 1) return;
  const column = service === "web_push"
    ? pushNotificationTargetTable.endpoint
    : pushNotificationTargetTable.token;
  await db.delete(pushNotificationTargetTable)
    .where(
      and(
        eq(pushNotificationTargetTable.accountId, accountId),
        eq(pushNotificationTargetTable.service, service),
        inArray(column, values),
      ),
    );
}

export function pushTargetHasToken(
  target: Pick<PushNotificationTarget, "token">,
): target is PushNotificationTarget & { token: string } {
  return target.token != null;
}

export function pushTargetHasEndpoint(
  target: Pick<PushNotificationTarget, "endpoint" | "p256dh" | "auth">,
): target is PushNotificationTarget & {
  endpoint: string;
  p256dh: string;
  auth: string;
} {
  return target.endpoint != null && target.p256dh != null &&
    target.auth != null;
}
