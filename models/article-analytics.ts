import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Database, Transaction } from "./db.ts";
import { runInTransaction } from "./db.ts";
import {
  articleContentTable,
  articleSourceTable,
  articleViewDailyTable,
  articleViewDeduplicationTable,
  articleViewLanguageDailyTable,
  articleViewReferrerDailyTable,
  ARTICLE_REFERRER_CATEGORIES,
  instanceTable,
  organizationMembershipTable,
  type ArticleReferrerCategory,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

const articleViewDeduplicationWindowMs = 30 * 60 * 1000;
const articleAnalyticsMinimumGroupSize = 3;
const articleAnalyticsMaximumTrendBuckets = 90;
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

export const ARTICLE_ANALYTICS_RANGES = [
  "seven_days",
  "thirty_days",
  "ninety_days",
  "all",
] as const;

export type ArticleAnalyticsRange = (typeof ARTICLE_ANALYTICS_RANGES)[number];
export type ArticleAnalyticsTrendInterval = "day" | "week" | "month" | "year";

export interface ArticleAnalyticsTrendPoint {
  start: Date;
  views: number;
}

export interface ArticleAnalyticsLanguage {
  language: string | null;
  original: boolean | null;
  views: number;
  share: number;
}

export interface ArticleAnalyticsReferrer {
  category: ArticleReferrerCategory;
  views: number;
  share: number;
}

export interface ArticleAnalyticsExternalDomain {
  domain: string;
  views: number;
  share: number;
}

export interface ArticleViewAnalytics {
  range: ArticleAnalyticsRange;
  from: Date | null;
  to: Date;
  totalViews: number;
  trendInterval: ArticleAnalyticsTrendInterval;
  trend: ArticleAnalyticsTrendPoint[];
  languages: ArticleAnalyticsLanguage[];
  referrers: ArticleAnalyticsReferrer[];
  externalDomains: ArticleAnalyticsExternalDomain[];
  otherExternalViews: number;
  lastUpdated: Date | null;
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

function getRangeStart(range: ArticleAnalyticsRange, today: Date): Date | null {
  const days =
    range === "seven_days"
      ? 7
      : range === "thirty_days"
        ? 30
        : range === "ninety_days"
          ? 90
          : null;
  return days == null
    ? null
    : new Date(today.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
}

function getTrendInterval(
  firstDay: Date,
  today: Date,
): ArticleAnalyticsTrendInterval {
  const inclusiveDays =
    Math.floor((today.getTime() - firstDay.getTime()) / (24 * 60 * 60 * 1000)) +
    1;
  if (inclusiveDays <= articleAnalyticsMaximumTrendBuckets) return "day";
  const weekMilliseconds = 7 * 24 * 60 * 60 * 1000;
  const inclusiveWeeks =
    Math.floor(
      (getBucketStart(today, "week").getTime() -
        getBucketStart(firstDay, "week").getTime()) /
        weekMilliseconds,
    ) + 1;
  if (inclusiveWeeks <= articleAnalyticsMaximumTrendBuckets) return "week";

  const inclusiveMonths =
    (today.getUTCFullYear() - firstDay.getUTCFullYear()) * 12 +
    today.getUTCMonth() -
    firstDay.getUTCMonth() +
    1;
  return inclusiveMonths <= articleAnalyticsMaximumTrendBuckets
    ? "month"
    : "year";
}

function getBucketStart(
  date: Date,
  interval: ArticleAnalyticsTrendInterval,
): Date {
  if (interval === "day") return getUtcDay(date);
  if (interval === "week") {
    const day = getUtcDay(date);
    const daysSinceMonday = (day.getUTCDay() + 6) % 7;
    return new Date(day.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  }
  if (interval === "month") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function getNextBucket(
  date: Date,
  interval: ArticleAnalyticsTrendInterval,
): Date {
  if (interval === "day") {
    return new Date(date.getTime() + 24 * 60 * 60 * 1000);
  }
  if (interval === "week") {
    return new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  if (interval === "month") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
  return new Date(Date.UTC(date.getUTCFullYear() + 1, 0, 1));
}

function buildArticleViewTrend(
  dailyViews: ReadonlyArray<{ day: Date; views: number }>,
  from: Date,
  to: Date,
  interval: ArticleAnalyticsTrendInterval,
): ArticleAnalyticsTrendPoint[] {
  const totals = new Map<number, number>();
  const firstBucket = getBucketStart(from, interval).getTime();
  for (const row of dailyViews) {
    const bucket = Math.max(
      getBucketStart(row.day, interval).getTime(),
      firstBucket,
    );
    totals.set(bucket, (totals.get(bucket) ?? 0) + row.views);
  }

  const trend: ArticleAnalyticsTrendPoint[] = [];
  const end = getBucketStart(to, interval).getTime();
  for (
    let bucket = getBucketStart(from, interval);
    bucket.getTime() <= end;
    bucket = getNextBucket(bucket, interval)
  ) {
    trend.push({ start: bucket, views: totals.get(bucket.getTime()) ?? 0 });
  }
  return trend;
}

function getShare(views: number, totalViews: number): number {
  return totalViews < 1 ? 0 : views / totalViews;
}

export async function getArticleViewAnalytics(
  db: Database | Transaction,
  articleSourceId: Uuid,
  range: ArticleAnalyticsRange,
  now = new Date(),
): Promise<ArticleViewAnalytics> {
  const today = getUtcDay(now);
  const from = getRangeStart(range, today);
  const rangeCondition =
    from == null
      ? and(
          eq(articleViewDailyTable.articleSourceId, articleSourceId),
          lte(articleViewDailyTable.day, today),
        )
      : and(
          eq(articleViewDailyTable.articleSourceId, articleSourceId),
          gte(articleViewDailyTable.day, from),
          lte(articleViewDailyTable.day, today),
        );
  const languageCondition =
    from == null
      ? and(
          eq(articleViewLanguageDailyTable.articleSourceId, articleSourceId),
          lte(articleViewLanguageDailyTable.day, today),
        )
      : and(
          eq(articleViewLanguageDailyTable.articleSourceId, articleSourceId),
          gte(articleViewLanguageDailyTable.day, from),
          lte(articleViewLanguageDailyTable.day, today),
        );
  const referrerCondition =
    from == null
      ? and(
          eq(articleViewReferrerDailyTable.articleSourceId, articleSourceId),
          lte(articleViewReferrerDailyTable.day, today),
        )
      : and(
          eq(articleViewReferrerDailyTable.articleSourceId, articleSourceId),
          gte(articleViewReferrerDailyTable.day, from),
          lte(articleViewReferrerDailyTable.day, today),
        );

  const [dailyViews, languageViews, referrerViews, updatedRows] =
    await Promise.all([
      db
        .select({
          day: articleViewDailyTable.day,
          views: articleViewDailyTable.views,
        })
        .from(articleViewDailyTable)
        .where(rangeCondition)
        .orderBy(articleViewDailyTable.day),
      db
        .select({
          language: articleViewLanguageDailyTable.language,
          original: articleViewLanguageDailyTable.original,
          views: articleViewLanguageDailyTable.views,
        })
        .from(articleViewLanguageDailyTable)
        .where(languageCondition),
      db
        .select({
          category: articleViewReferrerDailyTable.category,
          domain: articleViewReferrerDailyTable.domain,
          views: articleViewReferrerDailyTable.views,
        })
        .from(articleViewReferrerDailyTable)
        .where(referrerCondition),
      db
        .select({ updated: articleViewDailyTable.updated })
        .from(articleViewDailyTable)
        .where(eq(articleViewDailyTable.articleSourceId, articleSourceId))
        .orderBy(desc(articleViewDailyTable.updated))
        .limit(1),
    ]);

  const totalViews = dailyViews.reduce((total, row) => total + row.views, 0);
  const firstDay = from ?? dailyViews[0]?.day ?? today;
  const trendInterval = getTrendInterval(firstDay, today);
  const trendFrom =
    trendInterval === "year" &&
    today.getUTCFullYear() - firstDay.getUTCFullYear() >=
      articleAnalyticsMaximumTrendBuckets
      ? new Date(
          Date.UTC(
            today.getUTCFullYear() - (articleAnalyticsMaximumTrendBuckets - 1),
            0,
            1,
          ),
        )
      : firstDay;
  const trend = buildArticleViewTrend(
    dailyViews,
    trendFrom,
    today,
    trendInterval,
  );

  const languageTotals = new Map<
    string,
    { language: string; original: boolean; views: number }
  >();
  for (const row of languageViews) {
    const key = `${row.language}\u0000${row.original ? "1" : "0"}`;
    const existing = languageTotals.get(key);
    languageTotals.set(key, {
      language: row.language,
      original: row.original,
      views: (existing?.views ?? 0) + row.views,
    });
  }
  const visibleLanguages = [...languageTotals.values()]
    .filter((row) => row.views >= articleAnalyticsMinimumGroupSize)
    .sort((a, b) => b.views - a.views || a.language.localeCompare(b.language));
  const hiddenLanguageViews = [...languageTotals.values()]
    .filter((row) => row.views < articleAnalyticsMinimumGroupSize)
    .reduce((total, row) => total + row.views, 0);
  const languages: ArticleAnalyticsLanguage[] = visibleLanguages.map((row) => ({
    ...row,
    share: getShare(row.views, totalViews),
  }));
  if (hiddenLanguageViews > 0) {
    languages.push({
      language: null,
      original: null,
      views: hiddenLanguageViews,
      share: getShare(hiddenLanguageViews, totalViews),
    });
  }

  const referrerTotals = new Map<ArticleReferrerCategory, number>();
  const externalDomainTotals = new Map<string, number>();
  for (const row of referrerViews) {
    referrerTotals.set(
      row.category,
      (referrerTotals.get(row.category) ?? 0) + row.views,
    );
    if (row.category === "other_external") {
      externalDomainTotals.set(
        row.domain,
        (externalDomainTotals.get(row.domain) ?? 0) + row.views,
      );
    }
  }
  const referrers = ARTICLE_REFERRER_CATEGORIES.map((category) => {
    const views = referrerTotals.get(category) ?? 0;
    return { category, views, share: getShare(views, totalViews) };
  });
  const qualifyingDomains = [...externalDomainTotals.entries()]
    .filter(([, views]) => views >= articleAnalyticsMinimumGroupSize)
    .sort(([domainA, viewsA], [domainB, viewsB]) =>
      viewsB === viewsA ? domainA.localeCompare(domainB) : viewsB - viewsA,
    );
  const externalDomains = qualifyingDomains
    .slice(0, 10)
    .map(([domain, views]) => ({
      domain,
      views,
      share: getShare(views, totalViews),
    }));
  const visibleExternalViews = externalDomains.reduce(
    (total, row) => total + row.views,
    0,
  );
  const totalExternalViews = [...externalDomainTotals.values()].reduce(
    (total, views) => total + views,
    0,
  );

  return {
    range,
    from,
    to: today,
    totalViews,
    trendInterval,
    trend,
    languages,
    referrers,
    externalDomains,
    otherExternalViews: totalExternalViews - visibleExternalViews,
    lastUpdated: updatedRows[0]?.updated ?? null,
  };
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
