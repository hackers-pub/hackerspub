import assert from "node:assert";
import test from "node:test";
import { postLinkTable, postTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { sql } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  insertPostLink,
  makeGuestContext,
  withRollback,
} from "../test/postgres.ts";

interface QueryPlan {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  "Actual Loops"?: number;
  Plans?: QueryPlan[];
}

test("PostLink visibility stops after finding a visible referencing post", async (t) => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "linkvisibilityplan",
      name: "Link Visibility",
      email: "linkvisibilityplan@example.com",
    });
    const link = await insertPostLink(tx, {
      url: "https://example.com/popular-visible-link",
      title: "Popular link",
    });
    const orphan = await insertPostLink(tx, {
      url: "https://example.com/orphan-visible-link",
      title: "Orphan link",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      link: { id: link.id, url: link.url },
    });
    await tx.insert(postTable).values(
      Array.from({ length: 2000 }, () => {
        const id = generateUuidV7();
        return {
          ...post,
          id,
          noteSourceId: null,
          iri: `https://example.com/posts/${id}`,
          url: `https://example.com/posts/${id}`,
        };
      }),
    );
    // Include unrelated links so the planner sees a realistic distribution,
    // rather than assuming that every link references half the post table.
    const unrelatedLinks = Array.from({ length: 2000 }, () => {
      const id = generateUuidV7();
      return { id, url: `https://example.com/unrelated-link/${id}` };
    });
    await tx.insert(postLinkTable).values(unrelatedLinks);
    await tx.insert(postTable).values(
      unrelatedLinks.map((other) => {
        const id = generateUuidV7();
        return {
          ...post,
          id,
          noteSourceId: null,
          linkId: other.id,
          linkUrl: other.url,
          iri: `https://example.com/posts/${id}`,
          url: `https://example.com/posts/${id}`,
        };
      }),
    );
    await tx.execute(sql`analyze ${postTable}`);
    const queries: { statement: string; parameters: unknown[] }[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, statement, parameters) => {
      if (statement.includes('inner join "actor"')) {
        queries.push({ statement, parameters: [...parameters] });
      }
    };
    try {
      const result = await execute({
        schema,
        document: parse(`query($ids: [ID!]!) {
          nodes(ids: $ids) { ... on PostLink { url title } }
        }`),
        variableValues: {
          ids: [link.id, orphan.id].map((id) => encodeGlobalID("PostLink", id)),
        },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
        nodes: [
          { url: link.url, title: link.title },
          { url: orphan.url, title: orphan.title },
        ],
      });
    } finally {
      postgres.options.debug = originalDebug;
    }
    assert.equal(queries.length, 1);
    let inspectedPosts = 0;
    for (const { statement, parameters } of queries) {
      const query = sql.join(
        statement.split(/(\$\d+)/).map((part) => {
          if (!/^\$\d+$/.test(part)) return sql.raw(part);
          const value = parameters[Number(part.slice(1)) - 1];
          return sql`${value instanceof Date ? value.toISOString() : value}`;
        }),
        sql.empty(),
      );
      const rows = await tx.execute(
        sql`explain (analyze, format json) ${query}`,
      );
      const plan = (
        rows[0]["QUERY PLAN"] as unknown as { Plan: QueryPlan }[]
      )[0].Plan;
      const walk = (node: QueryPlan): void => {
        if (node["Relation Name"] === "post") {
          inspectedPosts +=
            ((node["Actual Rows"] ?? 0) +
              (node["Rows Removed by Filter"] ?? 0)) *
            (node["Actual Loops"] ?? 0);
        }
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(plan);
    }
    t.diagnostic(
      `Link visibility inspected ${inspectedPosts} referencing posts`,
    );
    assert.ok(
      inspectedPosts > 0 && inspectedPosts <= 32,
      `Visibility inspected ${inspectedPosts} referencing posts`,
    );
  });
});
