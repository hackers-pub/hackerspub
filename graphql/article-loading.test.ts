import assert from "node:assert/strict";
import test from "node:test";
import type { Transaction } from "@hackerspub/models/db";
import { getMissingArticleMediumLabel } from "@hackerspub/models/markup";
import {
  accountTable,
  articleContentTable,
  articleSourceMediumTable,
  articleSourceTable,
  mediumTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
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
