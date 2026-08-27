import assert from "node:assert";
import test from "node:test";
import {
  articleContentTable,
  articleSourceTable,
  articleViewDailyTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const recordArticleViewMutation = parse(`
  mutation RecordArticleView(
    $articleSourceId: UUID!
    $language: Locale!
    $visitorToken: String!
    $referrerHostname: String
  ) {
    recordArticleView(
      articleSourceId: $articleSourceId
      language: $language
      visitorToken: $visitorToken
      referrerHostname: $referrerHostname
    ) {
      counted
    }
  }
`);

const articleAnalyticsQuery = parse(`
  query ArticleAnalytics($articleSourceId: UUID!) {
    articleAnalytics(articleSourceId: $articleSourceId) {
      range
      totalViews
      trendInterval
      languages {
        language
        original
        views
      }
      referrers {
        category
        views
      }
      externalDomains {
        domain
      }
      otherExternalViews
      lastUpdated
    }
  }
`);

test("article view mutation records guests and deduplicates tokens", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "graphqlanalyticsauthor",
      name: "GraphQL Analytics Author",
      email: "graphqlanalyticsauthor@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-08-01T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "graphql-analytics",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "GraphQL analytics",
      content: "Content",
      published,
      updated: published,
    });
    const contextValue = makeGuestContext(tx, {
      request: new Request("http://localhost/graphql", {
        headers: { "user-agent": "Mozilla/5.0" },
      }),
    });
    const variableValues = {
      articleSourceId: sourceId,
      language: "en",
      visitorToken: "graphql-view-token-000000000000000",
      referrerHostname: "www.external.example",
    };

    const first = await execute({
      schema,
      document: recordArticleViewMutation,
      contextValue,
      variableValues,
    });
    assert.deepEqual(first.errors, undefined);
    assert.deepEqual(toPlainJson(first.data), {
      recordArticleView: { counted: true },
    });
    const duplicate = await execute({
      schema,
      document: recordArticleViewMutation,
      contextValue,
      variableValues,
    });
    assert.deepEqual(duplicate.errors, undefined);
    assert.deepEqual(toPlainJson(duplicate.data), {
      recordArticleView: { counted: false },
    });
    const authorView = await execute({
      schema,
      document: recordArticleViewMutation,
      contextValue: makeUserContext(tx, author.account),
      variableValues: {
        ...variableValues,
        visitorToken: "author-view-token-0000000000000000",
      },
    });
    assert.deepEqual(authorView.errors, undefined);
    assert.deepEqual(toPlainJson(authorView.data), {
      recordArticleView: { counted: false },
    });
    const botView = await execute({
      schema,
      document: recordArticleViewMutation,
      contextValue: makeGuestContext(tx, {
        request: new Request("http://localhost/graphql", {
          headers: { "user-agent": "Googlebot/2.1" },
        }),
      }),
      variableValues: {
        ...variableValues,
        visitorToken: "bot-view-token-000000000000000000",
      },
    });
    assert.deepEqual(botView.errors, undefined);
    assert.deepEqual(toPlainJson(botView.data), {
      recordArticleView: { counted: false },
    });
    assert.equal(
      await tx.$count(
        articleViewDailyTable,
        eq(articleViewDailyTable.articleSourceId, sourceId),
      ),
      1,
    );

    const analytics = await execute({
      schema,
      document: articleAnalyticsQuery,
      contextValue: makeUserContext(tx, author.account),
      variableValues: { articleSourceId: sourceId },
    });
    assert.deepEqual(analytics.errors, undefined);
    const analyticsData = toPlainJson(analytics.data) as {
      articleAnalytics: {
        range: string;
        totalViews: number;
        trendInterval: string;
        languages: unknown[];
        referrers: unknown[];
        externalDomains: unknown[];
        otherExternalViews: number;
        lastUpdated: string;
      };
    };
    const { lastUpdated, ...analyticsWithoutTimestamp } =
      analyticsData.articleAnalytics;
    assert.deepEqual(analyticsWithoutTimestamp, {
      range: "THIRTY_DAYS",
      totalViews: 1,
      trendInterval: "DAY",
      languages: [{ language: null, original: null, views: 1 }],
      referrers: [
        { category: "HACKERS_PUB", views: 0 },
        { category: "SEARCH", views: 0 },
        { category: "FEDIVERSE", views: 0 },
        { category: "OTHER_EXTERNAL", views: 1 },
        { category: "DIRECT_OR_UNKNOWN", views: 0 },
      ],
      externalDomains: [],
      otherExternalViews: 1,
    });
    assert.match(lastUpdated, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("article analytics hides data from guests and unrelated accounts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "privateanalyticsauthor",
      name: "Private Analytics Author",
      email: "privateanalyticsauthor@example.com",
    });
    const outsider = await insertAccountWithActor(tx, {
      username: "privateanalyticsoutsider",
      name: "Private Analytics Outsider",
      email: "privateanalyticsoutsider@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-08-01T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "private-graphql-analytics",
      published,
      updated: published,
    });

    for (const contextValue of [
      makeGuestContext(tx),
      makeUserContext(tx, outsider.account),
    ]) {
      const result = await execute({
        schema,
        document: articleAnalyticsQuery,
        contextValue,
        variableValues: { articleSourceId: sourceId },
      });
      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), { articleAnalytics: null });
    }
  });
});
