import assert from "node:assert";
import { createHash } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  canViewArticleAnalytics,
  getViewableArticleAnalyticsPostIds,
  getViewableArticleAnalyticsSourceIds,
  getArticleSupplementalAnalytics,
  getArticleViewAnalytics,
  normalizeArticleReferrerHostname,
  pruneExpiredArticleViewDeduplications,
  recordArticleDelivery,
  recordArticlePublication,
  recordArticleView,
  updateArticleDeliveryStatus,
} from "./article-analytics.ts";
import {
  articleDeliveryEventTable,
  articlePublicationAnalyticsTable,
  articleContentTable,
  articleSourceTable,
  articleViewDailyTable,
  articleViewDeduplicationTable,
  articleViewLanguageDailyTable,
  articleViewReferrerDailyTable,
  followingTable,
  organizationMembershipTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  insertAccountWithActor,
  insertRemoteActor,
  seedInstance,
  withRollback,
} from "../test/postgres.ts";

test("publication delivery analytics retain only hashed remote servers", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "publicationanalyticsauthor",
      name: "Publication Analytics Author",
      email: "publicationanalyticsauthor@example.com",
    });
    const localFollower = await insertAccountWithActor(tx, {
      username: "publicationanalyticslocal",
      name: "Publication Analytics Local Follower",
      email: "publicationanalyticslocal@example.com",
    });
    const acceptedRemote = await insertRemoteActor(tx, {
      username: "accepted",
      name: "Accepted Remote Follower",
      host: "delivery.example",
    });
    const pendingRemote = await insertRemoteActor(tx, {
      username: "pending",
      name: "Pending Remote Follower",
      host: "pending.example",
    });
    const accepted = new Date("2026-08-27T10:00:00.000Z");
    await tx.insert(followingTable).values([
      {
        iri: "https://delivery.example/follows/article-author",
        followerId: acceptedRemote.id,
        followeeId: author.actor.id,
        accepted,
      },
      {
        iri: "https://pending.example/follows/article-author",
        followerId: pendingRemote.id,
        followeeId: author.actor.id,
      },
      {
        iri: "http://localhost/follows/article-author",
        followerId: localFollower.actor.id,
        followeeId: author.actor.id,
        accepted,
      },
    ]);
    const sourceId = generateUuidV7();
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "publication-delivery",
      published: accepted,
      updated: accepted,
    });
    const activityId = "http://localhost/articles/publication-delivery#create";
    await recordArticlePublication(tx, {
      articleSourceId: sourceId,
      createActivityIri: activityId,
      actorId: author.actor.id,
      published: accepted,
      now: accepted,
    });
    await recordArticlePublication(tx, {
      articleSourceId: sourceId,
      createActivityIri: activityId,
      actorId: author.actor.id,
      published: accepted,
      now: new Date("2026-08-27T11:00:00.000Z"),
    });

    await recordArticleDelivery(tx, {
      messageId: "publication-delivery-message",
      activityId,
      inbox: "https://DELIVERY.example/users/accepted/inbox",
      channel: "direct",
      now: accepted,
    });
    await recordArticleDelivery(tx, {
      messageId: "ignored-invalid-inbox",
      activityId,
      inbox: "not an inbox URL",
      channel: "direct",
      now: accepted,
    });
    await recordArticleDelivery(tx, {
      messageId: "ignored-ip-inbox",
      activityId,
      inbox: "https://192.0.2.1/inbox",
      channel: "direct",
      now: accepted,
    });
    await updateArticleDeliveryStatus(
      tx,
      "publication-delivery-message",
      "accepted",
      accepted,
    );

    const publication =
      await tx.query.articlePublicationAnalyticsTable.findFirst({
        where: { articleSourceId: sourceId },
      });
    assert.equal(publication?.remoteFollowers, 1);
    const deliveries = await tx.select().from(articleDeliveryEventTable);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, "accepted");
    assert.equal(deliveries[0].channel, "direct");
    assert.deepEqual(
      deliveries[0].serverKey,
      createHash("sha256").update("delivery.example").digest(),
    );
    assert.equal(
      JSON.stringify(deliveries[0]).includes("delivery.example"),
      false,
    );
    assert.equal(await tx.$count(articlePublicationAnalyticsTable), 1);
  });
});

test("supplemental analytics apply per-server delivery precedence", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "deliverysummaryauthor",
      name: "Delivery Summary Author",
      email: "deliverysummaryauthor@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-08-27T00:00:00.000Z");
    const activityId = "http://localhost/articles/delivery-summary#create";
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "delivery-summary",
      published,
      updated: published,
    });
    await tx.insert(postTable).values({
      id: generateUuidV7(),
      iri: "http://localhost/articles/delivery-summary",
      type: "Article",
      visibility: "public",
      actorId: author.actor.id,
      articleSourceId: sourceId,
      contentHtml: "<p>Delivery summary</p>",
      repliesCount: 2,
      sharesCount: 3,
      quotesCount: 4,
      reactionsCounts: { "👍": 5 },
      published,
      updated: published,
    });
    await recordArticlePublication(tx, {
      articleSourceId: sourceId,
      createActivityIri: activityId,
      actorId: author.actor.id,
      published,
      now: published,
    });

    const deliveries = [
      ["direct-accepted", "direct-a.example", "direct", "accepted", 1],
      ["direct-pending", "direct-a.example", "direct", "pending", 2],
      ["direct-failed", "direct-b.example", "direct", "failed", 3],
      ["relay-pending", "relay-a.example", "relay", "pending", 4],
      ["relay-failed", "relay-b.example", "relay", "failed", 5],
      ["relay-accepted", "relay-b.example", "relay", "accepted", 6],
    ] as const;
    for (const [messageId, hostname, channel, status, minute] of deliveries) {
      const now = new Date(`2026-08-27T00:0${minute}:00.000Z`);
      await recordArticleDelivery(tx, {
        messageId,
        activityId,
        inbox: `https://${hostname}/inbox`,
        channel,
        now,
      });
      await updateArticleDeliveryStatus(tx, messageId, status, now);
    }

    assert.deepEqual(await getArticleSupplementalAnalytics(tx, sourceId), {
      federation: {
        published,
        remoteFollowers: 0,
        direct: {
          attemptedServers: 2,
          acceptedServers: 1,
          pendingServers: 0,
          failedServers: 1,
          successRate: 0.5,
        },
        relay: {
          attemptedServers: 2,
          acceptedServers: 1,
          pendingServers: 1,
          failedServers: 0,
          successRate: 0.5,
        },
        lastUpdated: new Date("2026-08-27T00:06:00.000Z"),
      },
      engagement: { replies: 2, shares: 3, quotes: 4, reactions: 5 },
    });

    const legacySourceId = generateUuidV7();
    await tx.insert(articleSourceTable).values({
      id: legacySourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "legacy-delivery-summary",
      published,
      updated: published,
    });
    assert.deepEqual(
      await getArticleSupplementalAnalytics(tx, legacySourceId),
      {
        federation: null,
        engagement: { replies: 0, shares: 0, quotes: 0, reactions: 0 },
      },
    );
  });
});

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
    const postId = generateUuidV7();
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
    await tx.insert(postTable).values({
      id: postId,
      iri: "http://localhost/articles/organization-analytics",
      type: "Article",
      visibility: "public",
      actorId: organization.actor.id,
      articleSourceId: sourceId,
      contentHtml: "<p>Content</p>",
      published,
      updated: published,
    });

    assert.equal(
      await canViewArticleAnalytics(tx, sourceId, {
        accountId: member.account.id,
        moderator: false,
      }),
      true,
    );
    assert.equal(
      await canViewArticleAnalytics(tx, sourceId, {
        accountId: outsider.account.id,
        moderator: false,
      }),
      false,
    );
    assert.equal(
      await canViewArticleAnalytics(tx, sourceId, {
        accountId: outsider.account.id,
        moderator: true,
      }),
      true,
    );
    assert.equal(
      await canViewArticleAnalytics(tx, generateUuidV7(), {
        accountId: member.account.id,
        moderator: true,
      }),
      false,
    );
    const viewableSourceIds = await getViewableArticleAnalyticsSourceIds(
      tx,
      [sourceId, generateUuidV7(), sourceId],
      { accountId: member.account.id, moderator: false },
    );
    assert.deepEqual([...viewableSourceIds], [sourceId]);
    assert.deepEqual(
      [
        ...(await getViewableArticleAnalyticsSourceIds(tx, [], {
          accountId: member.account.id,
          moderator: false,
        })),
      ],
      [],
    );
    assert.deepEqual(
      [
        ...(await getViewableArticleAnalyticsPostIds(
          tx,
          [postId, generateUuidV7(), postId],
          { accountId: member.account.id, moderator: false },
        )),
      ],
      [postId],
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
    await seedInstance(tx, "ported.example:8443", "mastodon");
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
      ["ported-fediverse-token-0000000000", "ported.example"],
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
        { category: "fediverse", domain: "", views: 3 },
        { category: "other_external", domain: "news.example.com", views: 1 },
        { category: "direct_or_unknown", domain: "", views: 1 },
      ],
    );
    assert.equal(
      await pruneExpiredArticleViewDeduplications(
        tx,
        new Date("2026-08-27T12:30:00.000Z"),
      ),
      6,
    );
  });
});

test("recordArticleView() caps external-domain row cardinality", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "domaincapauthor",
      name: "Domain Cap Author",
      email: "domaincapauthor@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-08-01T00:00:00.000Z");
    const day = new Date("2026-08-27T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "external-domain-cap",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "External domain cap",
      content: "Content",
      published,
      updated: published,
    });
    await tx.insert(articleViewReferrerDailyTable).values(
      Array.from({ length: 100 }, (_, index) => ({
        articleSourceId: sourceId,
        day,
        category: "other_external" as const,
        domain: `seed-${index}.example`,
        views: 1,
      })),
    );

    for (const index of [1, 2]) {
      assert.equal(
        await recordArticleView(tx, {
          articleSourceId: sourceId,
          language: "en",
          referrerHostname: `overflow-${index}.example`,
          canonicalHostname: "hackers.pub",
          visitorToken: `overflow-token-${index}-0000000000000000`,
          now: new Date("2026-08-27T12:00:00.000Z"),
        }),
        true,
      );
    }

    const rows = await tx.query.articleViewReferrerDailyTable.findMany({
      where: {
        articleSourceId: sourceId,
        day: { eq: day },
        category: "other_external",
      },
    });
    assert.equal(rows.length, 101);
    assert.deepEqual(
      rows.find((row) => row.domain === "__grouped__"),
      {
        articleSourceId: sourceId,
        day,
        category: "other_external",
        domain: "__grouped__",
        views: 2,
        updated: new Date("2026-08-27T12:00:00.000Z"),
      },
    );
  });
});

test("getArticleViewAnalytics() groups protected values and bounds trends", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "analyticsreader",
      name: "Analytics Reader",
      email: "analyticsreader@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-05-01T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "analytics-reader",
      published,
      updated: published,
    });
    await tx.insert(articleViewDailyTable).values([
      {
        articleSourceId: sourceId,
        day: new Date("2026-05-01T00:00:00.000Z"),
        views: 4,
        updated: new Date("2026-05-01T12:00:00.000Z"),
      },
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        views: 39,
        updated: new Date("2026-08-27T12:00:00.000Z"),
      },
    ]);
    await tx.insert(articleViewLanguageDailyTable).values([
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        language: "en",
        original: true,
        views: 36,
      },
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        language: "ko",
        original: false,
        views: 2,
      },
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        language: "fr",
        original: true,
        views: 1,
      },
    ]);
    await tx.insert(articleViewReferrerDailyTable).values([
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        category: "hackers_pub",
        views: 2,
      },
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        category: "search",
        views: 1,
      },
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        category: "fediverse",
        views: 1,
      },
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        category: "direct_or_unknown",
        views: 1,
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        category: "other_external" as const,
        domain: `d${index.toString().padStart(2, "0")}.example`,
        views: 3,
      })),
      {
        articleSourceId: sourceId,
        day: new Date("2026-08-27T00:00:00.000Z"),
        category: "other_external",
        domain: "tiny.example",
        views: 1,
      },
    ]);

    const analytics = await getArticleViewAnalytics(
      tx,
      sourceId,
      "thirty_days",
      new Date("2026-08-27T23:00:00.000Z"),
    );
    assert.equal(analytics.totalViews, 39);
    assert.equal(analytics.trendInterval, "day");
    assert.equal(analytics.trend.length, 30);
    assert.equal(analytics.trend.at(-1)?.views, 39);
    assert.deepEqual(analytics.languages, [
      { language: "en", original: true, views: 36, share: 36 / 39 },
      { language: null, original: null, views: 3, share: 3 / 39 },
    ]);
    assert.equal(
      analytics.referrers.reduce((total, row) => total + row.views, 0),
      39,
    );
    assert.equal(analytics.externalDomains.length, 10);
    assert.deepEqual(analytics.externalDomains[0], {
      domain: "d00.example",
      views: 3,
      share: 3 / 39,
    });
    assert.equal(analytics.otherExternalViews, 4);
    assert.equal(
      analytics.lastUpdated?.toISOString(),
      "2026-08-27T12:00:00.000Z",
    );

    const lifetime = await getArticleViewAnalytics(
      tx,
      sourceId,
      "all",
      new Date("2026-08-27T23:00:00.000Z"),
    );
    assert.equal(lifetime.totalViews, 43);
    assert.equal(lifetime.trendInterval, "week");
    assert.ok(lifetime.trend.length <= 90);
  });
});

test("getArticleViewAnalytics() accounts for aligned week boundaries", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "analyticsboundary",
      name: "Analytics Boundary",
      email: "analyticsboundary@example.com",
    });
    const sourceId = generateUuidV7();
    const firstDay = new Date("2025-01-05T00:00:00.000Z");
    const lastDay = new Date(firstDay.getTime() + 629 * 24 * 60 * 60 * 1000);
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2025,
      slug: "aligned-week-boundaries",
      published: firstDay,
      updated: firstDay,
    });
    await tx.insert(articleViewDailyTable).values([
      { articleSourceId: sourceId, day: firstDay, views: 1 },
      { articleSourceId: sourceId, day: lastDay, views: 1 },
    ]);

    const analytics = await getArticleViewAnalytics(
      tx,
      sourceId,
      "all",
      lastDay,
    );
    assert.equal(analytics.trendInterval, "month");
    assert.ok(analytics.trend.length <= 90);
  });
});
