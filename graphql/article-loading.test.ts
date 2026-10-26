import assert from "node:assert/strict";
import test from "node:test";
import type { Transaction } from "@hackerspub/models/db";
import { getMissingArticleMediumLabel } from "@hackerspub/models/markup";
import { getTranslationReviewStates } from "@hackerspub/models/article-translation-review";
import {
  accountTable,
  articleContentTable,
  articleSourceMediumTable,
  articleSourceRevisionTable,
  articleSourceTable,
  mediumTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { and, eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import type { UserContext } from "./builder.ts";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  createFedCtx,
  createTestDisk,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

async function insertArticle(tx: Transaction, suffix: string) {
  const { account, actor } = await insertAccountWithActor(tx, {
    username: `articleload${suffix}`,
    name: "Article Loader",
    email: `articleload${suffix}@example.com`,
  });
  const sourceId = generateUuidV7();
  const postId = generateUuidV7();
  const published = new Date("2026-04-15T00:00:00Z");
  await tx.insert(articleSourceTable).values({
    id: sourceId,
    accountId: account.id,
    publishedYear: 2026,
    slug: `load-${suffix}`,
    published,
    updated: published,
  });
  await tx.insert(articleContentTable).values(
    ["en", "ko"].map((language) => ({
      sourceId,
      language,
      title: `Title ${language}`,
      content: `# Heading ${language}\n\n![hero](hp-medium:hero)\n\n![missing](hp-medium:missing)`,
      originalLanguage: language === "en" ? null : "en",
      provenance: language === "en" ? null : ("unknown" as const),
      summary: "Summary",
      summaryUnnecessary: true,
      published,
      updated: published,
    })),
  );
  await tx.insert(postTable).values({
    id: postId,
    iri: `http://localhost/objects/${postId}`,
    type: "Article",
    actorId: actor.id,
    articleSourceId: sourceId,
    visibility: "public",
    contentHtml: "<p>Article</p>",
    published,
    updated: published,
  });
  return { account, sourceId, postId, id: encodeGlobalID("Article", postId) };
}

async function insertMedium(tx: Transaction, key: string) {
  const id = generateUuidV7();
  await tx.insert(mediumTable).values({ id, key, type: "image/png" });
  return id;
}

const renderingQuery = parse(`query($first: ID!, $second: ID!) {
  first: node(id: $first) { ...RenderedArticle }
  second: node(id: $second) { ...RenderedArticle }
}
fragment RenderedArticle on Article {
  contents(language: "en") { language content toc ogImageUrl }
  korean: contents(language: "ko") { language content toc ogImageUrl }
  again: contents { language content }
}`);

interface RenderedContent {
  language: string;
  content: string;
  toc: unknown[];
  ogImageUrl: string | null;
}

async function renderArticles(ctx: UserContext, ids: string[]) {
  const result = await execute({
    schema,
    document: renderingQuery,
    variableValues: { first: ids[0], second: ids[1] ?? ids[0] },
    contextValue: ctx,
    onError: "NO_PROPAGATE",
  });
  assert.equal(result.errors, undefined);
  const data = toPlainJson(result.data) as Record<
    string,
    {
      contents: RenderedContent[];
      korean: RenderedContent[];
      again: RenderedContent[];
    }
  >;
  return {
    nodes: [data.first, data.second].map((node) => ({
      contents: [...node.contents, ...node.korean],
      again: node.again,
    })),
  };
}

test("article rendering shares media reads across fields and languages, per request and snapshot", async () => {
  await withRollback(async (tx) => {
    const first = await insertArticle(tx, "first");
    const second = await insertArticle(tx, "second");
    const oldMedium = await insertMedium(tx, "old.png");
    const newMedium = await insertMedium(tx, "new.png");
    const avatar = await insertMedium(tx, "avatar.png");
    for (const account of [first.account, second.account]) {
      await tx
        .update(accountTable)
        .set({ avatarMediumId: avatar })
        .where(eq(accountTable.id, account.id));
    }
    const memoryDisk = createTestDisk() as UserContext["disk"];
    const originalGetUrl = memoryDisk.getUrl.bind(memoryDisk);
    memoryDisk.getUrl = (key) =>
      key === "avatar.png"
        ? Promise.resolve(
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
          )
        : originalGetUrl(key);
    await tx.insert(articleSourceMediumTable).values({
      articleSourceId: first.sourceId,
      key: "hero",
      mediumId: oldMedium,
    });
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    const mediaReads = () =>
      queries.filter((query) => query.includes('from "article_source_medium"'));
    try {
      const ctx = makeGuestContext(tx, { disk: memoryDisk });
      const data = await renderArticles(ctx, [first.id, second.id]);
      assert.equal(mediaReads().length, 2, "one media lookup per source");
      for (const content of data.nodes[0].contents) {
        assert.ok(content.content.includes("http://localhost/media/old.png"));
        assert.ok(content.toc.length > 0);
        assert.match(
          content.ogImageUrl!,
          /^http:\/\/localhost\/media\/.+\.png$/,
        );
        const missing = /data:image\/svg\+xml[^"]+/.exec(content.content)?.[0];
        assert.ok(missing);
        assert.ok(
          decodeURIComponent(missing).includes(
            getMissingArticleMediumLabel(content.language),
          ),
          "missing-media labels remain language-specific",
        );
        assert.equal(
          data.nodes[0].again.find((row) => row.language === content.language)
            ?.content,
          content.content,
        );
      }
      assert.ok(
        data.nodes[1].contents.every((row) => !row.content.includes("old.png")),
        "an empty source must not reuse another source's mapping",
      );

      await tx
        .update(articleSourceMediumTable)
        .set({ mediumId: newMedium })
        .where(eq(articleSourceMediumTable.articleSourceId, first.sourceId));
      queries.length = 0;
      const fresh = await renderArticles(
        makeGuestContext(tx, { disk: memoryDisk }),
        [first.id],
      );
      assert.equal(mediaReads().length, 1);
      assert.ok(fresh.nodes[0].contents[0].content.includes("new.png"));

      await tx.transaction(async (savepoint) => {
        ctx.db = savepoint;
        queries.length = 0;
        const retried = await renderArticles(ctx, [first.id]);
        assert.equal(mediaReads().length, 1, "a new DB handle reads again");
        assert.ok(retried.nodes[0].contents[0].content.includes("new.png"));
      });

      await tx
        .update(postTable)
        .set({ censored: new Date() })
        .where(eq(postTable.id, first.postId));
      queries.length = 0;
      const hidden = await renderArticles(
        makeGuestContext(tx, { disk: memoryDisk }),
        [first.id],
      );
      assert.equal(mediaReads().length, 0);
      assert.ok(hidden.nodes[0].contents.every((row) => row.content === ""));
      assert.ok(hidden.nodes[0].contents.every((row) => row.toc.length === 0));
      assert.ok(
        hidden.nodes[0].contents.every((row) => row.ogImageUrl === null),
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("article media reads stay fresh across root mutation payloads", async () => {
  await withRollback(async (tx) => {
    const article = await insertArticle(tx, "mutation");
    const mediumId = await insertMedium(tx, "attached.png");
    const result = await execute({
      schema,
      document: parse(`mutation($id: ID!, $source: UUID!, $medium: UUID!) {
        before: updateArticle(input: {articleId: $id, title: "Media freshness"}) {
          __typename
          ... on InvalidInputError { inputPath }
          ... on UpdateArticlePayload { article { contents { language content } } }
        }
        attachArticleSourceMedium(input: {articleSourceId: $source, mediumId: $medium, key: "hero"}) {
          __typename
        }
        after: updateArticle(input: {articleId: $id, title: "Media freshness"}) {
          __typename
          ... on InvalidInputError { inputPath }
          ... on UpdateArticlePayload { article { contents { language content } } }
        }
      }`),
      variableValues: {
        id: article.id,
        source: article.sourceId,
        medium: mediumId,
      },
      contextValue: makeUserContext(tx, article.account, {
        fedCtx: {
          ...createFedCtx(tx),
          request: new Request("http://localhost/graphql"),
        } as UserContext["fedCtx"],
      }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    const data = toPlainJson(result.data) as {
      before: { __typename: string; article: { contents: RenderedContent[] } };
      after: { __typename: string; article: { contents: RenderedContent[] } };
      attachArticleSourceMedium: { __typename: string };
    };
    assert.equal(
      data.before.__typename,
      "UpdateArticlePayload",
      JSON.stringify(data),
    );
    assert.equal(
      data.after.__typename,
      "UpdateArticlePayload",
      JSON.stringify(data),
    );
    assert.equal(
      data.attachArticleSourceMedium.__typename,
      "AttachArticleSourceMediumPayload",
    );
    assert.ok(
      data.before.article.contents.every(
        (row) => !row.content.includes("attached.png"),
      ),
    );
    assert.ok(
      data.after.article.contents.every((row) =>
        row.content.includes("attached.png"),
      ),
    );
  });
});

async function insertReviewRevisions(
  tx: Transaction,
  article: Awaited<ReturnType<typeof insertArticle>>,
) {
  const current = generateUuidV7();
  const previous = generateUuidV7();
  await tx.insert(articleSourceRevisionTable).values(
    [current, previous].map((id) => ({
      id,
      sourceId: article.sourceId,
      language: "en",
      title: "Original",
      content: "Private revision Markdown",
    })),
  );
  await tx
    .update(articleContentTable)
    .set({ sourceRevisionId: current })
    .where(eq(articleContentTable.sourceId, article.sourceId));
  await tx.insert(articleContentTable).values(
    [
      { language: "ja", sourceRevisionId: previous },
      { language: "zh", sourceRevisionId: null },
    ].map((row) => ({
      ...row,
      sourceId: article.sourceId,
      title: "Translation",
      content: "Translated Markdown",
      originalLanguage: "en",
      provenance: "unknown" as const,
    })),
  );
  return { current, previous };
}

const reviewStatesQuery = parse(`query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Article {
    contents { language reviewState }
    again: contents { language reviewState }
  } }
}`);

interface ReviewContent {
  language: string;
  reviewState: "CURRENT" | "NEEDS_REVIEW" | "UNKNOWN_BASELINE" | null;
}

async function readReviewStates(ctx: UserContext, ids: string[]) {
  const result = await execute({
    schema,
    document: reviewStatesQuery,
    variableValues: { ids },
    contextValue: ctx,
    onError: "NO_PROPAGATE",
  });
  assert.equal(result.errors, undefined);
  return toPlainJson(result.data) as {
    nodes: { contents: ReviewContent[]; again: ReviewContent[] }[];
  };
}

test("public review states share only the current revision pointer across translations and aliases", async () => {
  await withRollback(async (tx) => {
    const first = await insertArticle(tx, "review");
    const second = await insertArticle(tx, "legacy");
    const revisions = await insertReviewRevisions(tx, first);
    const expected = await getTranslationReviewStates(tx, {
      sourceId: first.sourceId,
    });
    const enumValues = {
      current: "CURRENT",
      needsReview: "NEEDS_REVIEW",
      unknownBaseline: "UNKNOWN_BASELINE",
    };
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    const pointerReads = () =>
      queries.filter(
        (query) =>
          query.startsWith('select "d0"."source_revision_id"') &&
          query.includes('from "article_content"'),
      );
    try {
      const ctx = makeGuestContext(tx);
      const data = await readReviewStates(ctx, [first.id, second.id]);
      assert.equal(pointerReads().length, 2, "one pointer query per source");
      assert.ok(pointerReads().every((query) => !query.includes('"content"')));
      assert.ok(
        queries.every(
          (query) => !query.includes('from "article_source_revision"'),
        ),
      );
      assert.deepEqual(data.nodes[0].again, data.nodes[0].contents);
      assert.deepEqual(
        Object.fromEntries(
          data.nodes[0].contents.map((row) => [row.language, row.reviewState]),
        ),
        {
          en: null,
          ko: "CURRENT",
          ja: "NEEDS_REVIEW",
          zh: "UNKNOWN_BASELINE",
        },
      );
      for (const row of data.nodes[0].contents) {
        if (row.language === "en") continue;
        assert.equal(
          row.reviewState,
          enumValues[expected.contents.get(row.language)!],
        );
      }
      assert.equal(
        data.nodes[1].contents.find((row) => row.language === "ko")
          ?.reviewState,
        "UNKNOWN_BASELINE",
      );

      queries.length = 0;
      const originalOnly = await execute({
        schema,
        document: parse(
          `query($id: ID!) { node(id: $id) { ... on Article { contents(language: "en") { reviewState } } } }`,
        ),
        variableValues: { id: first.id },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert.equal(originalOnly.errors, undefined);
      assert.equal(
        pointerReads().length,
        0,
        "original-language content needs no pointer lookup",
      );

      await tx
        .update(articleContentTable)
        .set({ sourceRevisionId: revisions.previous })
        .where(
          and(
            eq(articleContentTable.sourceId, first.sourceId),
            eq(articleContentTable.language, "en"),
          ),
        );
      queries.length = 0;
      const fresh = await readReviewStates(makeGuestContext(tx), [first.id]);
      assert.equal(pointerReads().length, 1);
      assert.equal(
        fresh.nodes[0].contents.find((row) => row.language === "ko")
          ?.reviewState,
        "NEEDS_REVIEW",
      );
      await tx.transaction(async (savepoint) => {
        ctx.db = savepoint;
        queries.length = 0;
        const retried = await readReviewStates(ctx, [first.id]);
        assert.equal(pointerReads().length, 1);
        assert.equal(
          retried.nodes[0].contents.find((row) => row.language === "ko")
            ?.reviewState,
          "NEEDS_REVIEW",
        );
      });

      await tx
        .update(articleContentTable)
        .set({ sourceRevisionId: null })
        .where(
          and(
            eq(articleContentTable.sourceId, first.sourceId),
            eq(articleContentTable.language, "en"),
          ),
        );
      const legacy = await readReviewStates(makeGuestContext(tx), [first.id]);
      assert.ok(
        legacy.nodes[0].contents
          .filter((row) => row.language !== "en")
          .every((row) => row.reviewState === "UNKNOWN_BASELINE"),
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("public review states stay fresh after an original edit in the same mutation", async () => {
  await withRollback(async (tx) => {
    const article = await insertArticle(tx, "reviewmutation");
    const { current } = await insertReviewRevisions(tx, article);
    const result = await execute({
      schema,
      document: parse(`mutation($id: ID!, $source: UUID!, $revision: UUID!) {
        before: acknowledgeArticleTranslationSource(input: {sourceId: $source, language: "ko", sourceRevisionId: $revision}) {
          __typename
          ... on AcknowledgeArticleTranslationSourcePayload { content { reviewState } }
        }
        after: updateArticle(input: {articleId: $id, content: "Edited original body"}) {
          __typename
          ... on UpdateArticlePayload { article { contents(language: "ko") { reviewState } } }
        }
      }`),
      variableValues: {
        id: article.id,
        source: article.sourceId,
        revision: current,
      },
      contextValue: makeUserContext(tx, article.account, {
        fedCtx: {
          ...createFedCtx(tx),
          request: new Request("http://localhost/graphql"),
        } as UserContext["fedCtx"],
      }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    const data = toPlainJson(result.data) as {
      before: { __typename: string; content: ReviewContent };
      after: { __typename: string; article: { contents: ReviewContent[] } };
    };
    assert.equal(
      data.before.__typename,
      "AcknowledgeArticleTranslationSourcePayload",
    );
    assert.equal(data.after.__typename, "UpdateArticlePayload");
    assert.equal(data.before.content.reviewState, "CURRENT");
    assert.deepEqual(data.after.article.contents, [
      { reviewState: "NEEDS_REVIEW" },
    ]);
  });
});
