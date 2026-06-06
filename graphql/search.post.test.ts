import assert from "node:assert";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { accountTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  insertAccountWithActor,
  insertNotePost,
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
    const allIds = (toPlainJson(allResults.data) as {
      searchPost: { edges: Array<{ node: { id: string } }> };
    }).searchPost.edges.map((edge) => edge.node.id);
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
    await tx.update(accountTable)
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
