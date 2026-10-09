import assert from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { accountTable, postTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const searchPostQuery = parse(`
  query SearchPost($query: String!, $languages: [Locale!], $first: Int) {
    searchPost(query: $query, languages: $languages, first: $first) {
      edges {
        node {
          id
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
      }
    }
  }
`);

test("TagPageQuery loads quoted note content in mixed post results", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "searchquotedcontent",
      name: "Search Quoted Content",
      email: "searchquotedcontent@example.com",
    });
    const { post: quoted } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>Quoted post body</p>",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>searchquotedcontenttarget</p>",
    });
    await tx
      .update(postTable)
      .set({ quotedPostId: quoted.id })
      .where(eq(postTable.id, post.id));
    for (const type of ["Article", "Question"] as const) {
      const other = await insertRemotePost(tx, {
        actorId: author.actor.id,
        contentHtml: "<p>searchquotedcontenttarget other type</p>",
      });
      await tx
        .update(postTable)
        .set({ type })
        .where(eq(postTable.id, other.id));
    }
    const artifact = readFileSync(
      new URL(
        "../web-next/src/__generated__/TagPageQuery.graphql.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const tagDocument = artifact.match(/"text": ("(?:[^"\\]|\\.)*")/);
    assert.ok(
      tagDocument,
      "The generated tag query must contain a wire document",
    );
    const cardResult = await execute({
      schema,
      // Relay's generated artifact imports runtime-only type names, so read
      // its wire document without importing the module under native stripping.
      document: parse(JSON.parse(tagDocument[1])),
      variableValues: {
        query: "searchquotedcontenttarget",
        tag: "searchquotedcontenttarget",
        locale: "en-US",
        languages: [],
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(cardResult.errors, undefined);
    const data = toPlainJson(cardResult.data) as {
      searchPost: {
        edges: Array<{
          node: {
            id: string;
            quotedPost?: { id: string; content: string } | null;
          };
        }>;
      };
    };
    assert.equal(data.searchPost.edges.length, 3);
    const note = data.searchPost.edges.find(
      ({ node }) => node.id === encodeGlobalID("Note", post.id),
    );
    assert.ok(note?.node.quotedPost);
    assert.equal(note.node.quotedPost.id, encodeGlobalID("Note", quoted.id));
    assert.equal(note.node.quotedPost.content, "<p>Quoted post body</p>");
  });
});

test("actor search reuses preloaded relations across list items", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "searchmappingviewer",
      name: "Search Mapping Viewer",
      email: "searchmappingviewer@example.com",
    });
    const usernames = [1, 2, 3].map((index) => `searchmappingactor${index}`);
    for (const username of usernames) {
      await insertRemoteActor(tx, {
        username,
        name: username,
        host: "searchmapping.example",
      });
    }
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      const result = await execute({
        schema,
        document: parse(`query {
          searchActorsByHandle(prefix: "searchmappingactor") {
            handle
            instance { host software }
          }
        }`),
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        searchActorsByHandle: usernames.map((username) => ({
          handle: `@${username}@searchmapping.example`,
          instance: { host: "searchmapping.example", software: "hackerspub" },
        })),
      });
      assert.equal(
        queries.filter((query) => query.includes('from "actor"')).length,
        1,
        "Root-query selections must avoid reloading actors and their instances",
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("searchPost selects candidate IDs without reading post bodies twice", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "searchprojection",
      name: "Search Projection",
      email: "searchprojection@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: `<p>searchprojectiontarget ${"Long body. ".repeat(10000)}</p>`,
    });
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      const result = await execute({
        schema,
        document: searchPostQuery,
        variableValues: { query: "searchprojectiontarget", first: 1 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        searchPost: {
          edges: [{ node: { id: encodeGlobalID("Note", post.id) } }],
          pageInfo: { hasNextPage: false, hasPreviousPage: false },
        },
      });
      const candidateQuery = queries.find(
        (query) =>
          query.includes('from "post" as "d0"') &&
          query.includes('"d0"."content_html" ilike'),
      );
      assert.ok(candidateQuery);
      assert.ok(
        !candidateQuery
          .slice(0, candidateQuery.indexOf('from "post"'))
          .includes('"content_html"'),
        "Candidate selection must not transfer post bodies before hydration",
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("searchPost returns matching public posts and respects language filters", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "searchpostauthor",
      name: "Search Post Author",
      email: "searchpostauthor@example.com",
    });
    const { post: english } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>searchpostunique target English</p>",
      language: "en",
    });
    await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>searchpostunique target Japanese</p>",
      language: "ja",
    });

    const allResults = await execute({
      schema,
      document: searchPostQuery,
      variableValues: { query: "searchpostunique", first: 10 },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(allResults.errors, undefined);
    const allIds = (
      toPlainJson(allResults.data) as {
        searchPost: { edges: Array<{ node: { id: string } }> };
      }
    ).searchPost.edges.map((edge) => edge.node.id);
    assert.ok(allIds.includes(encodeGlobalID("Note", english.id)));
    assert.equal(allIds.length, 2);

    const filteredResults = await execute({
      schema,
      document: searchPostQuery,
      variableValues: {
        query: "searchpostunique",
        languages: ["en"],
        first: 10,
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(filteredResults.errors, undefined);
    assert.deepEqual(toPlainJson(filteredResults.data), {
      searchPost: {
        edges: [{ node: { id: encodeGlobalID("Note", english.id) } }],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      },
    });
  });
});

test("searchPost limits before hydrating post relations", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "searchpostpageauthor",
      name: "Search Post Page Author",
      email: "searchpostpageauthor@example.com",
    });
    const { post: oldest } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>searchpostpaging oldest</p>",
      published: new Date("2026-04-10T00:00:00.000Z"),
    });
    const { post: middle } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>searchpostpaging middle</p>",
      published: new Date("2026-04-11T00:00:00.000Z"),
    });
    const { post: newest } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>searchpostpaging newest</p>",
      published: new Date("2026-04-12T00:00:00.000Z"),
    });

    const result = await execute({
      schema,
      document: searchPostQuery,
      variableValues: { query: "searchpostpaging", first: 2 },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const data = toPlainJson(result.data) as {
      searchPost: { edges: Array<{ node: { id: string } }> };
    };
    assert.deepEqual(data, {
      searchPost: {
        edges: [
          { node: { id: encodeGlobalID("Note", newest.id) } },
          { node: { id: encodeGlobalID("Note", middle.id) } },
        ],
        pageInfo: { hasNextPage: true, hasPreviousPage: false },
      },
    });
    assert.ok(
      !data.searchPost.edges
        .map((edge) => edge.node.id)
        .includes(encodeGlobalID("Note", oldest.id)),
    );
  });
});

test("searchPost rejects invalid search syntax and respects hidden foreign languages", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "searchpostviewer",
      name: "Search Post Viewer",
      email: "searchpostviewer@example.com",
    });
    await tx
      .update(accountTable)
      .set({ hideForeignLanguages: true, locales: ["ko"] })
      .where(eq(accountTable.id, account.account.id));

    const author = await insertAccountWithActor(tx, {
      username: "searchpostlangauthor",
      name: "Search Post Lang Author",
      email: "searchpostlangauthor@example.com",
    });
    await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>Hidden English searchpostforeign</p>",
      language: "en",
    });
    const { post: korean } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: "<p>Visible Korean searchpostforeign</p>",
      language: "ko",
    });

    const visibleResults = await execute({
      schema,
      document: searchPostQuery,
      variableValues: { query: "searchpostforeign", first: 10 },
      contextValue: makeUserContext(tx, {
        ...account.account,
        hideForeignLanguages: true,
        locales: ["ko"],
      }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(visibleResults.errors, undefined);
    assert.deepEqual(toPlainJson(visibleResults.data), {
      searchPost: {
        edges: [{ node: { id: encodeGlobalID("Note", korean.id) } }],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      },
    });

    const invalidQuery = await execute({
      schema,
      document: searchPostQuery,
      variableValues: { query: "(", first: 10 },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(toPlainJson(invalidQuery.data), { searchPost: null });
    assert.equal(
      invalidQuery.errors?.[0].message,
      "Invalid search query format",
    );
  });
});
