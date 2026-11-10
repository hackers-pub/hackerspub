import assert from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import type { RelationsFilter } from "@hackerspub/models/db";
import {
  getCensoredPostExclusionFilter,
  getPostVisibilityFilter,
} from "@hackerspub/models/post/visibility";
import {
  accountTable,
  actorTable,
  blockingTable,
  followingTable,
  postTable,
} from "@hackerspub/models/schema";
import { parseQuery } from "@hackerspub/models/search";
import { compileQuery } from "@hackerspub/models/search-query";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  insertMention,
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

test("hashtag pagination refills after moderation and visibility filters and retains language preferences", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "hashtagpageviewer",
      name: "Hashtag Page Viewer",
      email: "hashtagpageviewer@example.com",
    });
    const author = await insertRemoteActor(tx, {
      username: "hashtagpageauthor",
      name: "Author",
      host: "hashtagpage.example",
    });
    const pending = await insertRemoteActor(tx, {
      username: "hashtagpending",
      name: "Pending",
      host: "hashtagpage.example",
    });
    const blocked = await insertRemoteActor(tx, {
      username: "hashtagblocked",
      name: "Blocked",
      host: "hashtagpage.example",
    });
    const sanctioned = await insertRemoteActor(tx, {
      username: "hashtagsanctioned",
      name: "Sanctioned",
      host: "hashtagpage.example",
    });
    await tx.insert(followingTable).values([
      {
        iri: "http://localhost/follows/hashtagaccepted",
        followerId: viewer.actor.id,
        followeeId: author.id,
        accepted: new Date("2026-01-01Z"),
      },
      {
        iri: "http://localhost/follows/hashtagpending",
        followerId: viewer.actor.id,
        followeeId: pending.id,
      },
    ]);
    await tx.insert(blockingTable).values({
      id: generateUuidV7(),
      iri: "http://localhost/blocks/hashtagpage",
      blockerId: viewer.actor.id,
      blockeeId: blocked.id,
    });
    await tx
      .update(actorTable)
      .set({ suspended: new Date("2026-01-01Z"), suspendedUntil: null })
      .where(eq(actorTable.id, sanctioned.id));
    const ids: Array<typeof viewer.actor.id> = [];
    async function add(
      values: Parameters<typeof insertRemotePost>[1],
      censored = false,
    ) {
      const post = await insertRemotePost(tx, {
        language: "ko",
        ...values,
        published: new Date(Date.UTC(2026, 3, 1, 0, ids.length)),
      });
      ids.push(post.id);
      await tx
        .update(postTable)
        .set({
          tags: { hashtagpage452: "url" },
          ...(censored ? { censored: new Date("2026-04-01Z") } : {}),
        })
        .where(eq(postTable.id, post.id));
      return post;
    }
    await add({ actorId: author.id });
    await add({ actorId: author.id });
    await add({ actorId: author.id });
    for (const language of [
      "ko-KR",
      "en-US",
      "ko-KR",
      "en-US",
      "ko-KR",
      "en-US",
    ]) {
      await add({ actorId: author.id, language });
    }
    await add({ actorId: author.id, visibility: "followers" });
    await add({ actorId: author.id, visibility: "unlisted" });
    const direct = await add({ actorId: author.id, visibility: "direct" });
    await insertMention(tx, { postId: direct.id, actorId: viewer.actor.id });
    await add({ actorId: viewer.actor.id, visibility: "direct" }, true);
    // Every rejection class has more rows than a two-item page. LIMIT must
    // follow the complete filter, including for the signed-in viewer.
    for (let index = 0; index < 3; index++) {
      await add({ actorId: author.id }, true);
      await add({ actorId: author.id, language: "en" });
      await add({ actorId: blocked.id });
      await add({ actorId: sanctioned.id });
      await add({ actorId: pending.id, visibility: "followers" });
      await add({ actorId: author.id, visibility: "direct" });
      await add({ actorId: author.id, sharedPostId: ids[index] });
    }
    const document =
      parse(`query HashtagPage($query: String!, $languages: [Locale!], $first: Int!, $after: String) {
      searchPost(query: $query, languages: $languages, first: $first, after: $after) {
        edges { cursor node { id } }
        pageInfo { hasNextPage hasPreviousPage }
      }
    }`);
    const expression = parseQuery("#HASHTAGPAGE452");
    assert.ok(expression);
    const contexts = [
      {
        context: makeGuestContext(tx),
        languages: ["ko"],
        allowedLanguages: ["ko"],
      },
      {
        context: makeGuestContext(tx),
        languages: ["ko-KR", "en-US"],
        allowedLanguages: ["ko-KR", "ko", "en-US", "en"],
      },
      {
        context: makeUserContext(tx, {
          ...viewer.account,
          hideForeignLanguages: true,
          locales: ["ko-KR"],
        }),
        languages: [],
        allowedLanguages: ["ko-KR", "ko"],
      },
      {
        context: makeUserContext(tx, {
          ...viewer.account,
          hideForeignLanguages: true,
          locales: ["ko"],
        }),
        languages: [],
        allowedLanguages: ["ko"],
      },
      {
        context: makeUserContext(tx, {
          ...viewer.account,
          hideForeignLanguages: true,
          locales: ["ko"],
        }),
        languages: ["en"],
        allowedLanguages: ["en"],
      },
    ];
    for (const { context, languages, allowedLanguages } of contexts) {
      let after: string | undefined;
      const seen: string[] = [];
      for (let page = 0; page < ids.length; page++) {
        const common: RelationsFilter<"postTable"> = {
          AND: [
            { id: { in: ids } },
            getPostVisibilityFilter(context.account?.actor ?? null),
            getCensoredPostExclusionFilter(context.account?.actor.id),
            { sharedPostId: { isNull: true } },
            { language: { in: allowedLanguages } },
            ...(context.account == null
              ? [{ visibility: "public" } as const]
              : []),
            ...(after == null ? [] : [{ published: { lte: new Date(after) } }]),
          ],
        };
        const baseline = await tx.query.postTable.findMany({
          columns: { id: true, published: true },
          where: { AND: [common, compileQuery(expression)] },
          orderBy: { published: "desc" },
          limit: 3,
        });
        const result = await execute({
          schema,
          document,
          variableValues: {
            query: "#HASHTAGPAGE452",
            languages,
            first: 2,
            after,
          },
          contextValue: context,
          onError: "NO_PROPAGATE",
        });
        assert.equal(result.errors, undefined);
        const data = toPlainJson(result.data) as {
          searchPost: {
            edges: Array<{ cursor: string; node: { id: string } }>;
            pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
          };
        };
        const edges = data.searchPost.edges;
        assert.deepEqual(
          edges.map(({ node }) => node.id),
          baseline.slice(0, 2).map(({ id }) => encodeGlobalID("Note", id)),
        );
        assert.deepEqual(
          edges.map(({ cursor }) => cursor),
          baseline
            .slice(0, 2)
            .map(
              (_, index) => baseline[index + 1]?.published.toISOString() ?? "",
            ),
        );
        assert.equal(data.searchPost.pageInfo.hasNextPage, baseline.length > 2);
        assert.equal(data.searchPost.pageInfo.hasPreviousPage, false);
        seen.push(...edges.map(({ node }) => node.id));
        if (!data.searchPost.pageInfo.hasNextPage) break;
        assert.equal(edges.length, 2);
        assert.ok(edges[1].cursor);
        after = edges[1].cursor;
      }
      assert.equal(
        new Set(seen).size,
        seen.length,
        "forward pages must not repeat posts",
      );
      assert.ok(seen.length >= 3, "each case must traverse more than one page");
    }
  });
});

test("hashtag language preferences preserve empty, null and overridden locale behavior", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "hashtagemptylocales",
      name: "Empty locales",
      email: "hashtagemptylocales@example.com",
    });
    const post = await insertRemotePost(tx, {
      actorId: viewer.actor.id,
      language: "ko",
    });
    await tx
      .update(postTable)
      .set({ tags: { emptylocales461: "url" } })
      .where(eq(postTable.id, post.id));
    for (const { hideForeignLanguages, locales, languages, count } of [
      { hideForeignLanguages: true, locales: [], languages: [], count: 0 },
      { hideForeignLanguages: true, locales: null, languages: [], count: 1 },
      { hideForeignLanguages: false, locales: [], languages: [], count: 1 },
      {
        hideForeignLanguages: true,
        locales: [],
        languages: ["ko-KR"],
        count: 1,
      },
      {
        hideForeignLanguages: true,
        locales: ["ko-KR"],
        languages: ["en-US"],
        count: 0,
      },
    ] satisfies {
      hideForeignLanguages: boolean;
      locales: typeof viewer.account.locales;
      languages: string[];
      count: number;
    }[]) {
      for (const query of [
        "#emptylocales461",
        "#emptylocales461 OR absent461",
      ]) {
        const result = await execute({
          schema,
          document: searchPostQuery,
          variableValues: { query, languages, first: 5 },
          contextValue: makeUserContext(tx, {
            ...viewer.account,
            hideForeignLanguages,
            locales,
          }),
          onError: "NO_PROPAGATE",
        });
        assert.equal(result.errors, undefined);
        const data = toPlainJson(result.data) as {
          searchPost: { edges: unknown[]; pageInfo: { hasNextPage: boolean } };
        };
        assert.equal(
          data.searchPost.edges.length,
          count,
          JSON.stringify({ query, hideForeignLanguages, locales, languages }),
        );
        assert.equal(data.searchPost.pageInfo.hasNextPage, false);
      }
    }
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

test("searchPost keeps lookahead cursors without hydrating the lookahead post", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "searchlookahead",
      name: "Search Lookahead",
      email: "searchlookahead@example.com",
    });
    const posts = [];
    for (let index = 0; index < 3; index++) {
      const { post } = await insertNotePost(tx, {
        account: author.account,
        contentHtml: `<p>searchlookaheadtarget ${index}</p>`,
        published: new Date(`2026-04-1${3 - index}T00:00:00Z`),
      });
      await tx
        .update(postTable)
        .set({
          tags: { searchlookahead: "http://localhost/tags/searchlookahead" },
        })
        .where(eq(postTable.id, post.id));
      posts.push(post);
    }
    const document =
      parse(`query Lookahead($query: String!, $first: Int!, $after: String) {
      searchPost(query: $query, first: $first, after: $after) {
        edges { cursor node { id } }
        pageInfo { hasNextPage startCursor endCursor }
      }
    }`);
    const queries: { query: string; params: unknown[] }[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query, params) =>
      queries.push({ query, params });
    try {
      for (const query of ["searchlookaheadtarget", "#searchlookahead"]) {
        queries.length = 0;
        const result = await execute({
          schema,
          document,
          variableValues: { query, first: 2 },
          contextValue: makeGuestContext(tx),
          onError: "NO_PROPAGATE",
        });
        assert.equal(result.errors, undefined);
        assert.deepEqual(toPlainJson(result.data), {
          searchPost: {
            edges: [
              {
                node: { id: encodeGlobalID("Note", posts[0].id) },
                cursor: posts[1].published.toISOString(),
              },
              {
                node: { id: encodeGlobalID("Note", posts[1].id) },
                cursor: posts[2].published.toISOString(),
              },
            ],
            pageInfo: {
              hasNextPage: true,
              startCursor: posts[1].published.toISOString(),
              endCursor: posts[2].published.toISOString(),
            },
          },
        });
        const hydrated = queries.filter(({ query }) => {
          const from = query.indexOf('from "post" as "d0"');
          return from >= 0 && query.slice(0, from).includes('"content_html"');
        });
        assert.equal(hydrated.length, 1);
        assert.ok(hydrated[0].params.includes(posts[0].id));
        assert.ok(hydrated[0].params.includes(posts[1].id));
        assert.ok(
          !hydrated[0].params.includes(posts[2].id),
          "Lookahead must not load post bodies and relations",
        );
        const last = await execute({
          schema,
          document,
          variableValues: {
            query,
            first: 2,
            after: posts[2].published.toISOString(),
          },
          contextValue: makeGuestContext(tx),
          onError: "NO_PROPAGATE",
        });
        assert.equal(last.errors, undefined);
        assert.deepEqual(toPlainJson(last.data), {
          searchPost: {
            edges: [
              { node: { id: encodeGlobalID("Note", posts[2].id) }, cursor: "" },
            ],
            pageInfo: {
              hasNextPage: false,
              startCursor: null,
              endCursor: null,
            },
          },
        });
        queries.length = 0;
        const zero = await execute({
          schema,
          document,
          variableValues: { query, first: 0 },
          contextValue: makeGuestContext(tx),
          onError: "NO_PROPAGATE",
        });
        assert.equal(zero.errors, undefined);
        assert.deepEqual(toPlainJson(zero.data), {
          searchPost: {
            edges: [],
            pageInfo: { hasNextPage: true, startCursor: null, endCursor: null },
          },
        });
        assert.ok(
          !queries.some(({ query }) => {
            const from = query.indexOf('from "post" as "d0"');
            return from >= 0 && query.slice(0, from).includes('"content_html"');
          }),
          "Zero-size pages must not hydrate the lookahead row",
        );
      }
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});
