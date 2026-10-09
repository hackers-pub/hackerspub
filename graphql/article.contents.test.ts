import assert from "node:assert";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import {
  articleContentTable,
  articleSourceTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  insertAccountWithActor,
  makeGuestContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

test("Article.contents does not read translation bodies for metadata requests", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "contentsprojection",
      name: "Contents Projection",
      email: "contentsprojection@example.com",
    });
    const sourceId = generateUuidV7();
    const postId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "contents-projection",
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values(
      ["en", "ko", "ja"].map((language) => ({
        sourceId,
        language,
        title: `${language} title`,
        content: `Paragraph in ${language}.\n\n${"Long body. ".repeat(10000)}`,
        originalLanguage: language === "en" ? null : "en",
        provenance: language === "en" ? null : ("unknown" as const),
        beingTranslated: language === "ja",
        published,
        updated: published,
      })),
    );
    await tx.insert(postTable).values({
      id: postId,
      iri: `http://localhost/objects/${postId}`,
      type: "Article",
      actorId: author.actor.id,
      articleSourceId: sourceId,
      visibility: "public",
      contentHtml: "<p>Original</p>",
      published,
      updated: published,
    });
    const queries: string[] = [];
    const bodyQueryParameters: unknown[][] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query, parameters) => {
      queries.push(query);
      if (/\."content" as "content"/.test(query)) {
        bodyQueryParameters.push([...parameters]);
      }
    };
    try {
      const result = await execute({
        schema,
        document: parse(`query($id: ID!) {
          node(id: $id) { ... on Article {
            contents(language: "ko-KR") { language title }
            all: contents(includeBeingTranslated: true) { language }
          } }
        }`),
        variableValues: { id: encodeGlobalID("Article", postId) },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      const data = toPlainJson(result.data) as {
        node: {
          contents: { language: string; title: string }[];
          all: { language: string }[];
        };
      };
      assert.deepEqual(data.node.contents, [
        { language: "ko", title: "ko title" },
      ]);
      assert.deepEqual(data.node.all.map((row) => row.language).sort(), [
        "en",
        "ja",
        "ko",
      ]);
      assert.ok(queries.some((query) => query.includes('"article_content"')));
      assert.equal(
        queries.filter((query) => /\."content" as "content"/.test(query))
          .length,
        0,
        "Metadata requests must not load every translation body",
      );
      const bodyResult = await execute({
        schema,
        document: parse(`query($id: ID!) {
          node(id: $id) { ... on Article {
            contents(language: "ko-KR") { language rawContent }
          } }
        }`),
        variableValues: { id: encodeGlobalID("Article", postId) },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert.equal(bodyResult.errors, undefined);
      const bodyData = toPlainJson(bodyResult.data) as {
        node: { contents: { language: string; rawContent: string }[] };
      };
      assert.equal(bodyData.node.contents.length, 1);
      assert.equal(bodyData.node.contents[0].language, "ko");
      assert.ok(
        bodyData.node.contents[0].rawContent.startsWith("Paragraph in ko."),
      );
      assert.ok(bodyQueryParameters.length > 0);
      assert.ok(
        bodyQueryParameters.every((parameters) => parameters.includes("ko")),
        "A negotiated content request must only read the selected translation body",
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});
