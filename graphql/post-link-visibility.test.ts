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
  "Rows Removed by Index Recheck"?: number;
  "Actual Loops"?: number;
  Plans?: QueryPlan[];
}

function inspectedPostUpperBound(plan: QueryPlan): number {
  let rows = 0;
  const loops = plan["Actual Loops"] ?? 0;
  if (plan["Relation Name"] === "post" && loops > 0) {
    const counts = [
      plan["Actual Rows"] ?? 0,
      plan["Rows Removed by Filter"] ?? 0,
      plan["Rows Removed by Index Recheck"] ?? 0,
    ];
    // PostgreSQL 16/17 round per-loop averages to integers. One row across
    // two loops can therefore report zero. Bound each count conservatively
    // instead of treating the rounded values as exact totals.
    rows = Math.ceil(
      counts.reduce(
        (total, count) => total + count + (loops > 1 ? 0.5 : 0),
        0,
      ) * loops,
    );
  }
  return (
    rows +
    (plan.Plans ?? []).reduce(
      (total, child) => total + inspectedPostUpperBound(child),
      0,
    )
  );
}

test("PostLink plan accounting bounds rounded per-loop row counts", () => {
  assert.equal(
    inspectedPostUpperBound({
      "Relation Name": "post",
      "Actual Rows": 0,
      "Actual Loops": 2,
    }),
    3,
  );
  assert.equal(
    inspectedPostUpperBound({
      "Relation Name": "post",
      "Actual Rows": 4001,
      "Actual Loops": 1,
    }),
    4001,
  );
  assert.equal(
    inspectedPostUpperBound({
      "Relation Name": "post",
      "Actual Rows": 0,
      "Actual Loops": 0,
    }),
    0,
  );
  assert.equal(
    inspectedPostUpperBound({
      Plans: [
        {
          "Relation Name": "post",
          "Actual Rows": 1,
          "Rows Removed by Filter": 4,
          "Rows Removed by Index Recheck": 2,
          "Actual Loops": 1,
        },
      ],
    }),
    7,
  );
});

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
      inspectedPosts += inspectedPostUpperBound(plan);
    }
    t.diagnostic(
      `Link visibility inspected at most ${inspectedPosts} referencing posts`,
    );
    assert.ok(
      inspectedPosts > 0 && inspectedPosts <= 32,
      `Visibility inspected at most ${inspectedPosts} referencing posts`,
    );
  });
});
