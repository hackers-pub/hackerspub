import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  canViewArticleAnalytics,
  normalizeArticleReferrerHostname,
  pruneExpiredArticleViewDeduplications,
  recordArticleView,
} from "./article-analytics.ts";
import {
  articleContentTable,
  articleSourceTable,
  articleViewDeduplicationTable,
  organizationMembershipTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  insertAccountWithActor,
  seedInstance,
  withRollback,
} from "../test/postgres.ts";

test("normalizeArticleReferrerHostname() removes presentation prefixes", () => {
  assert.equal(
    normalizeArticleReferrerHostname("WWW.m.AMP.Bücher.Example."),
    "xn--bcher-kva.example",
  );
  assert.equal(
    normalizeArticleReferrerHostname("news.example.com"),
    "news.example.com",
  );
  assert.equal(normalizeArticleReferrerHostname("127.0.0.1"), null);
  assert.equal(normalizeArticleReferrerHostname("www.127.0.0.1"), null);
  assert.equal(normalizeArticleReferrerHostname("[2001:db8::1]"), null);
  assert.equal(normalizeArticleReferrerHostname("bad_host.example"), null);
});

test("recordArticleView() deduplicates and records aggregate dimensions", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "analyticsauthor",
      name: "Analytics Author",
      email: "analyticsauthor@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-08-01T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "analytics",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values([
      {
        sourceId,
        language: "en",
        title: "Analytics",
        content: "Original",
        published,
        updated: published,
      },
      {
        sourceId,
        language: "ko",
        title: "분석",
        content: "번역",
        originalLanguage: "en",
        published,
        updated: published,
      },
    ]);

    const baseInput = {
      articleSourceId: sourceId,
      language: "ko",
      referrerHostname: "www.google.com",
      canonicalHostname: "hackers.pub",
      visitorToken: "view-token-00000000000000000001",
      now: new Date("2026-08-27T23:59:00.000Z"),
    } as const;
    assert.equal(await recordArticleView(tx, baseInput), true);
    assert.equal(
      await recordArticleView(tx, {
        ...baseInput,
        now: new Date("2026-08-28T00:28:59.999Z"),
      }),
      false,
    );
    assert.equal(
      await recordArticleView(tx, {
        ...baseInput,
        now: new Date("2026-08-28T00:29:00.000Z"),
      }),
      true,
    );

    const daily = await tx.query.articleViewDailyTable.findMany({
      where: { articleSourceId: sourceId },
      orderBy: { day: "asc" },
    });
    assert.deepEqual(
      daily.map(({ day, views }) => [day.toISOString(), views]),
      [
        ["2026-08-27T00:00:00.000Z", 1],
        ["2026-08-28T00:00:00.000Z", 1],
      ],
    );
    const languages = await tx.query.articleViewLanguageDailyTable.findMany({
      where: { articleSourceId: sourceId },
      orderBy: { day: "asc" },
    });
    assert.deepEqual(
      languages.map(({ language, original, views }) => ({
        language,
        original,
        views,
      })),
      [
        { language: "ko", original: false, views: 1 },
        { language: "ko", original: false, views: 1 },
      ],
    );
    const referrers = await tx.query.articleViewReferrerDailyTable.findMany({
      where: { articleSourceId: sourceId },
      orderBy: { day: "asc" },
    });
    assert.deepEqual(
      referrers.map(({ category, domain, views }) => ({
        category,
        domain,
        views,
      })),
      [
        { category: "search", domain: "", views: 1 },
        { category: "search", domain: "", views: 1 },
      ],
    );
  });
});

test("recordArticleView() excludes editors and identifiable bots", async () => {
  await withRollback(async (tx) => {
    const organization = await insertAccountWithActor(tx, {
      username: "analyticsorg",
      name: "Analytics Org",
      email: "analyticsorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const member = await insertAccountWithActor(tx, {
      username: "analyticsmember",
      name: "Analytics Member",
      email: "analyticsmember@example.com",
    });
    const outsider = await insertAccountWithActor(tx, {
      username: "analyticsoutsider",
      name: "Analytics Outsider",
      email: "analyticsoutsider@example.com",
    });
    await tx.insert(organizationMembershipTable).values({
      organizationAccountId: organization.account.id,
      memberAccountId: member.account.id,
      accepted: new Date("2026-08-01T00:00:00.000Z"),
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-08-01T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: organization.account.id,
      publishedYear: 2026,
      slug: "organization-analytics",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Organization analytics",
      content: "Content",
      published,
      updated: published,
    });

    assert.equal(
      await canViewArticleAnalytics(tx, sourceId, member.account.id),
      true,
    );
    assert.equal(
      await canViewArticleAnalytics(tx, sourceId, outsider.account.id),
      false,
    );
    assert.equal(
      await canViewArticleAnalytics(tx, generateUuidV7(), member.account.id),
      false,
    );
    assert.equal(
      await recordArticleView(tx, {
        articleSourceId: sourceId,
        language: "en",
        referrerHostname: null,
        canonicalHostname: "hackers.pub",
        visitorToken: "member-token-000000000000000000",
        viewerAccountId: member.account.id,
      }),
      false,
    );
    assert.equal(
      await recordArticleView(tx, {
        articleSourceId: sourceId,
        language: "en",
        referrerHostname: null,
        canonicalHostname: "hackers.pub",
        visitorToken: "cubot-token-0000000000000000000",
        userAgent: "Mozilla/5.0 (Linux; Android 10; CUBOT NOTE 20 Build/QP1A)",
      }),
      true,
    );
    assert.equal(
      await recordArticleView(tx, {
        articleSourceId: sourceId,
        language: "en",
        referrerHostname: null,
        canonicalHostname: "hackers.pub",
        visitorToken: "bot-token-000000000000000000000",
        userAgent: "ExampleBot/1.0",
      }),
      false,
    );
    assert.equal(
      await tx.$count(
        articleViewDeduplicationTable,
        eq(articleViewDeduplicationTable.articleSourceId, sourceId),
      ),
      1,
    );
  });
});

test("recordArticleView() classifies fediverse and external referrers", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "referrerauthor",
      name: "Referrer Author",
      email: "referrerauthor@example.com",
    });
    await seedInstance(tx, "social.example", "mastodon");
    await seedInstance(tx, "m.cmx.im", "mastodon");
    const sourceId = generateUuidV7();
    const published = new Date("2026-08-01T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "referrers",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Referrers",
      content: "Content",
      published,
      updated: published,
    });

    for (const [visitorToken, referrerHostname] of [
      ["fediverse-token-0000000000000000", "social.example"],
      ["prefixed-fediverse-token-000000000", "m.cmx.im"],
      ["external-token-000000000000000000", "WWW.News.Example.COM."],
      ["invalid-token-0000000000000000000", "127.0.0.1"],
      ["internal-token-000000000000000000", "www.hackers.pub"],
    ] as const) {
      assert.equal(
        await recordArticleView(tx, {
          articleSourceId: sourceId,
          language: "en",
          referrerHostname,
          canonicalHostname: "hackers.pub",
          visitorToken,
          now: new Date("2026-08-27T12:00:00.000Z"),
        }),
        true,
      );
    }

    const referrers = await tx.query.articleViewReferrerDailyTable.findMany({
      where: { articleSourceId: sourceId },
      orderBy: { category: "asc" },
    });
    assert.deepEqual(
      referrers.map(({ category, domain, views }) => ({
        category,
        domain,
        views,
      })),
      [
        { category: "hackers_pub", domain: "", views: 1 },
        { category: "fediverse", domain: "", views: 2 },
        { category: "other_external", domain: "news.example.com", views: 1 },
        { category: "direct_or_unknown", domain: "", views: 1 },
      ],
    );
    assert.equal(
      await pruneExpiredArticleViewDeduplications(
        tx,
        new Date("2026-08-27T12:30:00.000Z"),
      ),
      5,
    );
  });
});
