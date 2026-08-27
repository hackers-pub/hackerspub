import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Database, Transaction } from "./db.ts";
import { runInTransaction } from "./db.ts";
import {
  articleContentTable,
  articleSourceTable,
  articleViewDailyTable,
  articleViewDeduplicationTable,
  articleViewLanguageDailyTable,
  articleViewReferrerDailyTable,
  instanceTable,
  organizationMembershipTable,
  type ArticleReferrerCategory,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

const articleViewDeduplicationWindowMs = 30 * 60 * 1000;
const removableHostnamePrefixes = new Set(["www", "m", "mobile", "amp"]);
const searchEngineDomains = [
  "baidu.com",
  "bing.com",
  "brave.com",
  "daum.net",
  "duckduckgo.com",
  "ecosia.org",
  "google.com",
  "kagi.com",
  "naver.com",
  "startpage.com",
  "yahoo.com",
  "yandex.com",
] as const;
const identifiableBotPattern =
  /(?:bot(?:\b|\/)|crawler|spider|slurp|facebookexternalhit|feedfetcher|headlesschrome|httpclient|linkpreview|preview|wget|curl)/i;

export interface RecordArticleViewInput {
  articleSourceId: Uuid;
  language: string;
  referrerHostname: string | null;
  canonicalHostname: string;
  /**
   * An opaque, per-article client token used only for best-effort 30-minute
   * deduplication. It is not an authentication or abuse-prevention token and
   * must not be derived from an IP address or browser fingerprint.
   */
  visitorToken: string;
  viewerAccountId?: Uuid | null;
  userAgent?: string | null;
  now?: Date;
}

export interface ClassifiedArticleReferrer {
  category: ArticleReferrerCategory;
  domain: string;
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function canonicalizeArticleReferrerHostname(hostname: string): string | null {
  let normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.length < 1 || isIP(normalized) !== 0) return null;

  normalized = domainToASCII(normalized);
  if (normalized.length < 1 || normalized.length > 253) return null;

  const labels = normalized.split(".");
  if (
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null;
  }

  return normalized;
}

export function normalizeArticleReferrerHostname(
  hostname: string,
): string | null {
  const canonical = canonicalizeArticleReferrerHostname(hostname);
  if (canonical == null) return null;
  const labels = canonical.split(".");
  while (labels.length > 1 && removableHostnamePrefixes.has(labels[0])) {
    labels.shift();
  }
  const stripped = labels.join(".");
  return isIP(stripped) === 0 ? stripped : null;
}

export function isIdentifiableArticleBot(userAgent: string | null): boolean {
  return (
    userAgent != null &&
    !/\bcubot\b/i.test(userAgent) &&
    identifiableBotPattern.test(userAgent)
  );
}

export async function classifyArticleReferrer(
  db: Database | Transaction,
  referrerHostname: string | null,
  canonicalHostname: string,
): Promise<ClassifiedArticleReferrer> {
  if (referrerHostname == null) {
    return { category: "direct_or_unknown", domain: "" };
  }

  const canonicalReferrer =
    canonicalizeArticleReferrerHostname(referrerHostname);
  const hostname = normalizeArticleReferrerHostname(referrerHostname);
  const ownHostname = normalizeArticleReferrerHostname(canonicalHostname);
  if (hostname == null) {
    return { category: "direct_or_unknown", domain: "" };
  }
  if (ownHostname != null && hostname === ownHostname) {
    return { category: "hackers_pub", domain: "" };
  }
  if (
    searchEngineDomains.some((domain) =>
      hostnameMatchesDomain(hostname, domain),
    )
  ) {
    return { category: "search", domain: "" };
  }

  const instanceHosts =
    canonicalReferrer == null || canonicalReferrer === hostname
      ? [hostname]
      : [canonicalReferrer, hostname];
  const instance = await db
    .select({ host: instanceTable.host })
    .from(instanceTable)
    .where(inArray(instanceTable.host, instanceHosts))
    .limit(1);
  if (instance.length > 0) {
    return { category: "fediverse", domain: "" };
  }
  return { category: "other_external", domain: hostname };
}

async function viewerCanEditArticle(
  db: Database | Transaction,
  articleAccountId: Uuid,
  viewerAccountId: Uuid,
): Promise<boolean> {
  if (articleAccountId === viewerAccountId) return true;
  const membership = await db
    .select({ memberAccountId: organizationMembershipTable.memberAccountId })
    .from(organizationMembershipTable)
    .where(
      and(
        eq(organizationMembershipTable.organizationAccountId, articleAccountId),
        eq(organizationMembershipTable.memberAccountId, viewerAccountId),
        isNotNull(organizationMembershipTable.accepted),
      ),
    )
    .limit(1);
  return membership.length > 0;
}

export async function canViewArticleAnalytics(
  db: Database | Transaction,
  articleSourceId: Uuid,
  viewerAccountId: Uuid,
): Promise<boolean> {
  const source = await db
    .select({ accountId: articleSourceTable.accountId })
    .from(articleSourceTable)
    .where(eq(articleSourceTable.id, articleSourceId))
    .limit(1);
  return (
    source[0] != null &&
    (await viewerCanEditArticle(db, source[0].accountId, viewerAccountId))
  );
}

function getUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function hashVisitorToken(visitorToken: string): Buffer {
  return createHash("sha256").update(visitorToken, "utf8").digest();
}

export async function recordArticleView(
  db: Database | Transaction,
  input: RecordArticleViewInput,
): Promise<boolean> {
  if (
    input.visitorToken.length < 16 ||
    input.visitorToken.length > 128 ||
    input.language.length < 1 ||
    input.language.length > 64 ||
    isIdentifiableArticleBot(input.userAgent ?? null)
  ) {
    return false;
  }

  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return false;

  return await runInTransaction(db, async (tx) => {
    const content = await tx
      .select({
        accountId: articleSourceTable.accountId,
        originalLanguage: articleContentTable.originalLanguage,
      })
      .from(articleContentTable)
      .innerJoin(
        articleSourceTable,
        eq(articleSourceTable.id, articleContentTable.sourceId),
      )
      .where(
        and(
          eq(articleContentTable.sourceId, input.articleSourceId),
          eq(articleContentTable.language, input.language),
        ),
      )
      .limit(1);
    if (content[0] == null) return false;
    if (
      input.viewerAccountId != null &&
      (await viewerCanEditArticle(
        tx,
        content[0].accountId,
        input.viewerAccountId,
      ))
    ) {
      return false;
    }

    const referrer = await classifyArticleReferrer(
      tx,
      input.referrerHostname,
      input.canonicalHostname,
    );
    const tokenHash = hashVisitorToken(input.visitorToken);
    const expires = new Date(now.getTime() + articleViewDeduplicationWindowMs);
    const deduplication = await tx
      .insert(articleViewDeduplicationTable)
      .values({
        articleSourceId: input.articleSourceId,
        tokenHash,
        expires,
      })
      .onConflictDoUpdate({
        target: [
          articleViewDeduplicationTable.articleSourceId,
          articleViewDeduplicationTable.tokenHash,
        ],
        set: { expires },
        setWhere: lte(articleViewDeduplicationTable.expires, now),
      })
      .returning({
        articleSourceId: articleViewDeduplicationTable.articleSourceId,
      });
    if (deduplication.length < 1) return false;

    const day = getUtcDay(now);
    await tx
      .insert(articleViewDailyTable)
      .values({
        articleSourceId: input.articleSourceId,
        day,
        views: 1,
        updated: now,
      })
      .onConflictDoUpdate({
        target: [
          articleViewDailyTable.articleSourceId,
          articleViewDailyTable.day,
        ],
        set: {
          views: sql`${articleViewDailyTable.views} + 1`,
          updated: now,
        },
      });
    await tx
      .insert(articleViewLanguageDailyTable)
      .values({
        articleSourceId: input.articleSourceId,
        day,
        language: input.language,
        original: content[0].originalLanguage == null,
        views: 1,
        updated: now,
      })
      .onConflictDoUpdate({
        target: [
          articleViewLanguageDailyTable.articleSourceId,
          articleViewLanguageDailyTable.day,
          articleViewLanguageDailyTable.language,
          articleViewLanguageDailyTable.original,
        ],
        set: {
          views: sql`${articleViewLanguageDailyTable.views} + 1`,
          updated: now,
        },
      });
    await tx
      .insert(articleViewReferrerDailyTable)
      .values({
        articleSourceId: input.articleSourceId,
        day,
        category: referrer.category,
        domain: referrer.domain,
        views: 1,
        updated: now,
      })
      .onConflictDoUpdate({
        target: [
          articleViewReferrerDailyTable.articleSourceId,
          articleViewReferrerDailyTable.day,
          articleViewReferrerDailyTable.category,
          articleViewReferrerDailyTable.domain,
        ],
        set: {
          views: sql`${articleViewReferrerDailyTable.views} + 1`,
          updated: now,
        },
      });
    return true;
  });
}

export async function pruneExpiredArticleViewDeduplications(
  db: Database | Transaction,
  now = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(articleViewDeduplicationTable)
    .where(lte(articleViewDeduplicationTable.expires, now));
  return deleted.count;
}
