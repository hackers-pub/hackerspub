import { getLogger } from "@logtape/logtape";
import { negotiateLocale } from "@hackerspub/models/i18n";
import { expandGlob } from "@std/fs";
import { escape } from "@std/html/entities";
import { join } from "@std/path";
import { createMessage, type Message, type Transport } from "@upyo/core";
import { count, desc, sql } from "drizzle-orm";
import type { Database, Transaction } from "@hackerspub/models/db";
import {
  accountTable,
  actorTable,
  moderationNotificationTable,
  notificationDigestDeliveryTable,
  type NotificationDigestFrequency,
  notificationTable,
  organizationMembershipTable,
  organizationNotificationReadTable,
} from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";

const logger = getLogger(["hackerspub", "graphql", "notification-digest"]);

const MAX_DIGEST_ITEMS = 10;
const DIGEST_DELIVERY_CLAIM_TIMEOUT_MINUTES = 15;
const LOCALES_DIR = join(import.meta.dirname!, "locales");

interface DigestAccount {
  id: Uuid;
  username: string;
  name: string;
  locales: string[] | null;
  notificationEmailDigestDaily: boolean;
  notificationEmailDigestWeekly: boolean;
  emails: { email: string; verified: Date | null }[];
}

interface DigestItem {
  created: Date;
  organizationName?: string;
  type: string;
  category: "personal" | "moderation" | "organization";
}

interface DigestSnapshot {
  totalCount: number;
  personalCount: number;
  moderationCount: number;
  organizationCount: number;
  items: DigestItem[];
}

interface SendNotificationDigestsOptions {
  db: Database | Transaction;
  email: Transport;
  from: string;
  origin: string | URL;
  frequency: NotificationDigestFrequency;
  now?: Date;
  limit?: number;
}

interface DigestEmailTemplate {
  dailyEmailSubject: string;
  weeklyEmailSubject: string;
  emailContent: string;
  itemLine: string;
  notificationLabels: Record<string, string>;
  moderationNotificationLabels: Record<string, string>;
}

export interface SendNotificationDigestsResult {
  accountsChecked: number;
  accountsClaimed: number;
  emailsSent: number;
  accountsFailed: number;
}

let cachedDigestTemplates: Map<string, DigestEmailTemplate> | null = null;
let cachedAvailableLocales: string[] | null = null;

function isDailyEmailQuotaError(message: string): boolean {
  return message.toLowerCase().includes("daily request limit exceeded");
}

function logDigestDeliveryFailure(accountId: Uuid, error: string): void {
  const properties = { accountId, error };
  if (isDailyEmailQuotaError(error)) {
    logger.warn(
      "Failed to send notification digest for account {accountId}: {error}",
      properties,
    );
  } else {
    logger.error(
      "Failed to send notification digest for account {accountId}: {error}",
      properties,
    );
  }
}

async function loadDigestEmailTemplates(): Promise<void> {
  if (cachedDigestTemplates != null && cachedAvailableLocales != null) return;

  const templates = new Map<string, DigestEmailTemplate>();
  const availableLocales: string[] = [];
  const files = expandGlob(join(LOCALES_DIR, "*.json"), {
    includeDirs: false,
  });
  for await (const file of files) {
    if (!file.isFile) continue;
    const match = file.name.match(/^(.+)\.json$/);
    if (match == null) continue;
    const localeName = match[1];
    const json = await Deno.readTextFile(file.path);
    const data = JSON.parse(json);
    if (data.digest == null) continue;
    templates.set(localeName, data.digest);
    availableLocales.push(localeName);
  }

  cachedDigestTemplates = templates;
  cachedAvailableLocales = availableLocales;
}

async function getDigestEmailTemplate(
  locales: readonly string[] | null,
): Promise<{ locale: Intl.Locale; template: DigestEmailTemplate }> {
  await loadDigestEmailTemplates();
  const selectedLocale = negotiateLocale(
    locales?.length ? locales : [new Intl.Locale("en")],
    cachedAvailableLocales!,
  ) ?? new Intl.Locale("en");
  const template = cachedDigestTemplates!.get(selectedLocale.baseName);
  if (template == null) {
    const fallback = cachedDigestTemplates!.get("en");
    if (fallback == null) {
      throw new Error("No notification digest email template found.");
    }
    return { locale: new Intl.Locale("en"), template: fallback };
  }
  return { locale: selectedLocale, template };
}

export function getNotificationDigestPeriodStart(
  frequency: NotificationDigestFrequency,
  now = new Date(),
): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (frequency === "weekly") {
    const day = start.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  }
  return start;
}

export function isWeeklyDigestDay(now = new Date()): boolean {
  return now.getUTCDay() === 1;
}

export async function sendNotificationDigests(
  options: SendNotificationDigestsOptions,
): Promise<SendNotificationDigestsResult> {
  const now = options.now ?? new Date();
  const periodStart = getNotificationDigestPeriodStart(
    options.frequency,
    now,
  );
  const origin = new URL(options.origin);
  const accounts = await options.db.query.accountTable.findMany({
    where: {
      kind: "personal",
      ...(options.frequency === "daily"
        ? { notificationEmailDigestDaily: true }
        : { notificationEmailDigestWeekly: true }),
    },
    with: {
      emails: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  }) as DigestAccount[];

  let accountsClaimed = 0;
  let emailsSent = 0;
  let accountsFailed = 0;
  for (const account of accounts) {
    if (
      options.frequency === "daily" &&
      account.notificationEmailDigestWeekly &&
      isWeeklyDigestDay(now)
    ) {
      continue;
    }
    const recipients = account.emails
      .filter((email) => email.verified != null)
      .map((email) => email.email);
    if (recipients.length < 1) continue;

    const snapshot = await getUnreadDigestSnapshot(options.db, account.id);
    if (snapshot.totalCount < 1) continue;

    const claim = await claimDigestDelivery(
      options.db,
      account.id,
      options.frequency,
      periodStart,
      snapshot.totalCount,
    );
    if (claim == null) continue;
    accountsClaimed++;
    const sentRecipients = new Set(claim.sentRecipients);
    const pendingRecipients = recipients.filter((recipient) =>
      !sentRecipients.has(recipient)
    );
    if (pendingRecipients.length < 1) {
      await markDigestDeliverySent(
        options.db,
        account.id,
        options.frequency,
        periodStart,
        [...sentRecipients],
      );
      continue;
    }

    try {
      const errors: string[] = [];
      const newlySentRecipients: string[] = [];
      for (const to of pendingRecipients) {
        const message = await getDigestMessage({
          account,
          frequency: options.frequency,
          from: options.from,
          origin,
          snapshot,
          to,
        });
        const receipt = await options.email.send(message);
        if (receipt.successful) {
          emailsSent++;
          sentRecipients.add(to);
          newlySentRecipients.push(to);
        } else {
          errors.push(...receipt.errorMessages);
        }
      }

      if (
        errors.length < 1 &&
        newlySentRecipients.length === pendingRecipients.length
      ) {
        await markDigestDeliverySent(
          options.db,
          account.id,
          options.frequency,
          periodStart,
          [...sentRecipients],
        );
      } else {
        accountsFailed++;
        const error = errors.join("; ") || "Unknown delivery failure.";
        logDigestDeliveryFailure(account.id, error);
        await markDigestDeliveryFailed(
          options.db,
          account.id,
          options.frequency,
          periodStart,
          error,
          [...sentRecipients],
        );
      }
    } catch (error) {
      accountsFailed++;
      const message = getErrorMessage(error);
      logDigestDeliveryFailure(account.id, message);
      await markDigestDeliveryFailed(
        options.db,
        account.id,
        options.frequency,
        periodStart,
        message,
        [...sentRecipients],
      );
    }
  }

  return {
    accountsChecked: accounts.length,
    accountsClaimed,
    emailsSent,
    accountsFailed,
  };
}

async function claimDigestDelivery(
  db: Database | Transaction,
  accountId: Uuid,
  frequency: NotificationDigestFrequency,
  periodStart: Date,
  notificationsCount: number,
): Promise<{ sentRecipients: string[] } | undefined> {
  const rows = await db.insert(notificationDigestDeliveryTable).values({
    accountId,
    frequency,
    periodStart,
    notificationsCount,
  }).onConflictDoUpdate({
    target: [
      notificationDigestDeliveryTable.accountId,
      notificationDigestDeliveryTable.frequency,
      notificationDigestDeliveryTable.periodStart,
    ],
    set: {
      notificationsCount,
      failed: null,
      error: null,
      created: sql`CURRENT_TIMESTAMP`,
    },
    setWhere: sql`
      ${notificationDigestDeliveryTable.sent} IS NULL
      AND (
        ${notificationDigestDeliveryTable.failed} IS NOT NULL
        OR ${notificationDigestDeliveryTable.created} <
          CURRENT_TIMESTAMP -
          (${DIGEST_DELIVERY_CLAIM_TIMEOUT_MINUTES}::text || ' minutes')::interval
      )
    `,
  }).returning({
    sentRecipients: notificationDigestDeliveryTable.sentRecipients,
  });
  return rows[0];
}

async function markDigestDeliverySent(
  db: Database | Transaction,
  accountId: Uuid,
  frequency: NotificationDigestFrequency,
  periodStart: Date,
  sentRecipients: string[],
): Promise<void> {
  await db.update(notificationDigestDeliveryTable).set({
    sent: sql`CURRENT_TIMESTAMP`,
    sentRecipients,
    failed: null,
    error: null,
  }).where(sql`
    ${notificationDigestDeliveryTable.accountId} = ${accountId}
    AND ${notificationDigestDeliveryTable.frequency} = ${frequency}
    AND ${notificationDigestDeliveryTable.periodStart} =
      ${periodStart.toISOString()}::timestamptz
  `);
}

async function markDigestDeliveryFailed(
  db: Database | Transaction,
  accountId: Uuid,
  frequency: NotificationDigestFrequency,
  periodStart: Date,
  error: string,
  sentRecipients: string[],
): Promise<void> {
  await db.update(notificationDigestDeliveryTable).set({
    sentRecipients,
    failed: sql`CURRENT_TIMESTAMP`,
    error: error.slice(0, 2000),
  }).where(sql`
    ${notificationDigestDeliveryTable.accountId} = ${accountId}
    AND ${notificationDigestDeliveryTable.frequency} = ${frequency}
    AND ${notificationDigestDeliveryTable.periodStart} =
      ${periodStart.toISOString()}::timestamptz
  `);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function getUnreadDigestSnapshot(
  db: Database | Transaction,
  accountId: Uuid,
): Promise<DigestSnapshot> {
  const [personalCount, moderationCount, organizationCount] = await Promise.all(
    [
      countPersonalUnreadNotifications(db, accountId),
      countModerationUnreadNotifications(db, accountId),
      countOrganizationUnreadNotifications(db, accountId),
    ],
  );
  const [personalItems, moderationItems, organizationItems] = await Promise.all(
    [
      getPersonalDigestItems(db, accountId, MAX_DIGEST_ITEMS),
      getModerationDigestItems(db, accountId, MAX_DIGEST_ITEMS),
      getOrganizationDigestItems(db, accountId, MAX_DIGEST_ITEMS),
    ],
  );
  const items = [...personalItems, ...moderationItems, ...organizationItems]
    .sort((a, b) => b.created.getTime() - a.created.getTime())
    .slice(0, MAX_DIGEST_ITEMS);
  return {
    totalCount: personalCount + moderationCount + organizationCount,
    personalCount,
    moderationCount,
    organizationCount,
    items,
  };
}

async function countPersonalUnreadNotifications(
  db: Database | Transaction,
  accountId: Uuid,
): Promise<number> {
  const rows = await db.select({ count: count() })
    .from(notificationTable)
    .where(sql`
      ${notificationTable.accountId} = ${accountId}
      AND ${notificationTable.created} > COALESCE(
        (
          SELECT ${accountTable.notificationRead}
          FROM ${accountTable}
          WHERE ${accountTable.id} = ${accountId}
        ),
        '-infinity'::timestamptz
      )
      AND EXISTS (
        SELECT 1
        FROM ${actorTable}
        WHERE ${actorTable.id} = ANY(${notificationTable.actorIds})
      )
    `);
  return Number(rows[0]?.count ?? 0);
}

async function countModerationUnreadNotifications(
  db: Database | Transaction,
  accountId: Uuid,
): Promise<number> {
  const rows = await db.select({ count: count() })
    .from(moderationNotificationTable)
    .where(sql`
      ${moderationNotificationTable.accountId} = ${accountId}
      AND ${moderationNotificationTable.read} IS NULL
    `);
  return Number(rows[0]?.count ?? 0);
}

async function countOrganizationUnreadNotifications(
  db: Database | Transaction,
  accountId: Uuid,
): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM ${notificationTable}
    JOIN ${organizationMembershipTable}
      ON ${organizationMembershipTable.organizationAccountId} =
        ${notificationTable.accountId}
    WHERE ${organizationMembershipTable.memberAccountId} = ${accountId}
      AND ${organizationMembershipTable.accepted} IS NOT NULL
      AND ${notificationTable.created} > COALESCE(
        (
          SELECT MAX(${organizationNotificationReadTable.readAt})
          FROM ${organizationNotificationReadTable}
          JOIN ${organizationMembershipTable} accepted_members
            ON accepted_members.organization_account_id =
              ${organizationNotificationReadTable.organizationAccountId}
            AND accepted_members.member_account_id =
              ${organizationNotificationReadTable.memberAccountId}
          WHERE ${organizationNotificationReadTable.organizationAccountId} =
            ${notificationTable.accountId}
            AND accepted_members.accepted IS NOT NULL
        ),
        '-infinity'::timestamptz
      )
      AND EXISTS (
        SELECT 1
        FROM ${actorTable}
        WHERE ${actorTable.id} = ANY(${notificationTable.actorIds})
      )
  `);
  return Number(rows[0]?.count ?? 0);
}

async function getPersonalDigestItems(
  db: Database | Transaction,
  accountId: Uuid,
  limit: number,
): Promise<DigestItem[]> {
  const rows = await db.select({
    type: notificationTable.type,
    created: notificationTable.created,
  })
    .from(notificationTable)
    .where(sql`
      ${notificationTable.accountId} = ${accountId}
      AND ${notificationTable.created} > COALESCE(
        (
          SELECT ${accountTable.notificationRead}
          FROM ${accountTable}
          WHERE ${accountTable.id} = ${accountId}
        ),
        '-infinity'::timestamptz
      )
      AND EXISTS (
        SELECT 1
        FROM ${actorTable}
        WHERE ${actorTable.id} = ANY(${notificationTable.actorIds})
      )
    `)
    .orderBy(desc(notificationTable.created))
    .limit(limit);
  return rows.map((row) => ({
    created: row.created,
    category: "personal",
    type: row.type,
  }));
}

async function getModerationDigestItems(
  db: Database | Transaction,
  accountId: Uuid,
  limit: number,
): Promise<DigestItem[]> {
  const rows = await db.select({
    type: moderationNotificationTable.type,
    created: moderationNotificationTable.created,
  })
    .from(moderationNotificationTable)
    .where(sql`
      ${moderationNotificationTable.accountId} = ${accountId}
      AND ${moderationNotificationTable.read} IS NULL
    `)
    .orderBy(desc(moderationNotificationTable.created))
    .limit(limit);
  return rows.map((row) => ({
    created: row.created,
    category: "moderation",
    type: row.type,
  }));
}

async function getOrganizationDigestItems(
  db: Database | Transaction,
  accountId: Uuid,
  limit: number,
): Promise<DigestItem[]> {
  const rows = await db.execute<{
    organization_name: string;
    type: string;
    created: Date;
  }>(sql`
    SELECT
      ${accountTable.name} AS organization_name,
      ${notificationTable.type}::text AS type,
      ${notificationTable.created} AS created
    FROM ${notificationTable}
    JOIN ${organizationMembershipTable}
      ON ${organizationMembershipTable.organizationAccountId} =
        ${notificationTable.accountId}
    JOIN ${accountTable}
      ON ${accountTable.id} = ${organizationMembershipTable.organizationAccountId}
    WHERE ${organizationMembershipTable.memberAccountId} = ${accountId}
      AND ${organizationMembershipTable.accepted} IS NOT NULL
      AND ${notificationTable.created} > COALESCE(
        (
          SELECT MAX(${organizationNotificationReadTable.readAt})
          FROM ${organizationNotificationReadTable}
          JOIN ${organizationMembershipTable} accepted_members
            ON accepted_members.organization_account_id =
              ${organizationNotificationReadTable.organizationAccountId}
            AND accepted_members.member_account_id =
              ${organizationNotificationReadTable.memberAccountId}
          WHERE ${organizationNotificationReadTable.organizationAccountId} =
            ${notificationTable.accountId}
            AND accepted_members.accepted IS NOT NULL
        ),
        '-infinity'::timestamptz
      )
      AND EXISTS (
        SELECT 1
        FROM ${actorTable}
        WHERE ${actorTable.id} = ANY(${notificationTable.actorIds})
      )
    ORDER BY ${notificationTable.created} DESC
    LIMIT ${limit}
  `);
  return rows.map((row) => ({
    created: new Date(row.created),
    category: "organization",
    organizationName: row.organization_name,
    type: row.type,
  }));
}

async function getDigestMessage(options: {
  account: DigestAccount;
  frequency: NotificationDigestFrequency;
  from: string;
  origin: URL;
  snapshot: DigestSnapshot;
  to: string;
}): Promise<Message> {
  const { locale, template } = await getDigestEmailTemplate(
    options.account.locales,
  );
  const notificationsUrl = new URL("/notifications", options.origin).href;
  const settingsUrl = new URL(
    `/@${options.account.username}/settings/preferences`,
    options.origin,
  ).href;
  const items = options.snapshot.items.map((item) =>
    substituteDigestTemplate(template.itemLine, {
      label: getDigestItemLabel(item, template),
      date: formatDigestDate(item.created, locale.baseName),
    })
  ).join("\n");
  const values = {
    name: options.account.name,
    count: options.snapshot.totalCount.toLocaleString(locale.baseName),
    personalCount: options.snapshot.personalCount.toLocaleString(
      locale.baseName,
    ),
    moderationCount: options.snapshot.moderationCount.toLocaleString(
      locale.baseName,
    ),
    organizationCount: options.snapshot.organizationCount.toLocaleString(
      locale.baseName,
    ),
    items,
    notificationsUrl,
    settingsUrl,
  };
  const subject = substituteDigestTemplate(
    options.frequency === "daily"
      ? template.dailyEmailSubject
      : template.weeklyEmailSubject,
    values,
  );
  const text = substituteDigestTemplate(template.emailContent, values);
  const escapedText = escape(text);
  const escapedNotificationsUrl = escape(notificationsUrl);
  const escapedSettingsUrl = escape(settingsUrl);
  return createMessage({
    from: options.from,
    to: options.to,
    subject,
    content: {
      text,
      html: escapedText
        .replaceAll(
          escapedNotificationsUrl,
          `<a href="${escapedNotificationsUrl}">${escapedNotificationsUrl}</a>`,
        )
        .replaceAll(
          escapedSettingsUrl,
          `<a href="${escapedSettingsUrl}">${escapedSettingsUrl}</a>`,
        )
        .replaceAll("\n", "<br>\n"),
    },
  });
}

function substituteDigestTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replaceAll(
    /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g,
    (match, key) => values[key]?.toString() ?? match,
  );
}

function getDigestItemLabel(
  item: DigestItem,
  template: DigestEmailTemplate,
): string {
  const labels = item.category === "moderation"
    ? template.moderationNotificationLabels
    : template.notificationLabels;
  const label = labels[item.type] ?? labels.notification ?? item.type;
  return item.organizationName == null
    ? label
    : `${item.organizationName}: ${label}`;
}

function formatDigestDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}
