import assert from "node:assert";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { relations } from "./relations.ts";
import {
  compileQuery,
  getRequiredHashtags,
  getRequiredLanguages,
  getSearchPostPage,
} from "./search-query.ts";
import { parseQuery } from "./search.ts";
import { postTable } from "./schema.ts";

test("hashtag search materializes the selective GIN lookup", () => {
  const filter = compileQuery({ type: "hashtag", hashtag: "Fediverse" });
  const raw = filter.RAW;
  assert.ok(typeof raw === "function");

  const query = new PgDialect().sqlToQuery(raw(postTable, {} as never));
  assert.match(query.sql, /WITH "hashtag_candidates" AS MATERIALIZED/);
  assert.match(query.sql, /"tags" \? \$1/);
  assert.deepEqual(query.params, ["fediverse"]);
});

test("required hashtags descend only through conjunctions and normalize before deduplication", () => {
  const cases: [string, string[]][] = [
    ["#Rust", ["rust"]],
    ["#Rust #rust #Web", ["rust", "web"]],
    ["#a keyword lang:ko author:alice -#b", ["a"]],
    ["(#a OR #b ) #c", ["c"]],
    ["#a (#b OR #c )", ["a"]],
    ["#a OR #b", []],
    ["(#a #b ) OR #c", []],
    ["-#a", []],
    ["-(#a )", []],
    ["keyword lang:ko author:alice", []],
  ];
  for (const [source, expected] of cases) {
    const expr = parseQuery(source);
    assert.ok(expr, source);
    assert.deepEqual(getRequiredHashtags(expr), expected, source);
  }
});

test("candidate rechecks retain exact existence semantics without the GIN operator", () => {
  const filter = compileQuery({ type: "hashtag", hashtag: "Fediverse" }, true);
  assert.ok(typeof filter.RAW === "function");
  const query = new PgDialect().sqlToQuery(filter.RAW(postTable, {} as never));
  assert.match(query.sql, /jsonb_exists\("post"\."tags", \$1\)/);
  assert.doesNotMatch(query.sql, /MATERIALIZED|\?/);
  assert.deepEqual(query.params, ["fediverse"]);
});

test("necessary language bounds preserve exact literals and boolean semantics", () => {
  const cases: [string, string[] | undefined][] = [
    ["#tag", undefined],
    ["#tag lang:KO", ["KO"]],
    ["#tag lang:ko lang:en", []],
    ["#tag lang:ko lang:ko", ["ko"]],
    ["#tag (lang:ko OR lang:en )", ["ko", "en"]],
    ["#tag (lang:ko OR keyword )", undefined],
    ["#tag (keyword OR lang:ko )", undefined],
    ["#tag -lang:ko", undefined],
    ["#tag -(lang:ko OR lang:en )", undefined],
    ["#tag (lang:ko OR lang:en ) lang:ko", ["ko"]],
  ];
  for (const [query, expected] of cases) {
    const expr = parseQuery(query);
    assert.ok(expr, query);
    assert.deepEqual(getRequiredLanguages(expr), expected, query);
  }
});

test("actual page SQL filters before limiting and intersects distinct required tags", async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[]) {
      queries.push({ sql: query, params });
      return { values: async () => [] };
    },
  } as unknown as ReturnType<typeof postgres>;
  const db = drizzle({ client, relations });
  const expr = parseQuery("#Popular #popular #Sparse -#Excluded lang:ko");
  assert.ok(expr);
  const until = new Date("2026-01-02T00:00:00.000Z");
  assert.deepEqual(
    await getSearchPostPage(
      db,
      expr,
      {
        visibility: "public",
        censored: { isNull: true },
        sharedPostId: { isNull: true },
        actor: { suspended: { isNull: true } },
      },
      { limit: 26, until },
    ),
    [],
  );
  assert.equal(queries.length, 1);
  const query = queries[0];
  assert.match(query.sql, /from "post_hashtag"/);
  assert.match(query.sql, /"tag_hash" = md5\(\$\d+\)::uuid/);
  assert.match(
    query.sql,
    /IN \(\s*SELECT "post_hashtag"\."post_id" FROM "post_hashtag"/,
  );
  assert.match(query.sql, /exists \(select .*from "post"/);
  assert.match(query.sql, /"censored" is null/);
  assert.match(query.sql, /"shared_post_id" is null/);
  assert.match(query.sql, /"suspended" is null/);
  assert.match(query.sql, /"language" = \$\d+/);
  assert.match(
    query.sql,
    /left\("d0"\."language", 64\) IN \(left\(\$\d+::text, 64\)\)/,
  );
  assert.equal((query.sql.match(/"published" <=/g) ?? []).length, 2);
  assert.match(query.sql, /order by .*"published" desc limit \$\d+$/);
  assert.doesNotMatch(query.sql, /MATERIALIZED|LATERAL|OFFSET|\?/);
  assert.deepEqual(query.params.slice(0, 3), ["popular", "ko", "sparse"]);
  assert.equal(query.params.at(-1), 26);

  queries.length = 0;
  const fallback = parseQuery("#Sparse OR keyword");
  assert.ok(fallback);
  await getSearchPostPage(db, fallback, {}, { limit: 26, until });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /from "post"/);
  assert.match(queries[0].sql, /AS MATERIALIZED/);
  assert.doesNotMatch(queries[0].sql, /post_hashtag|jsonb_exists/);
});

test("effective language options filter candidates and source rows on both query paths", async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[]) {
      queries.push({ sql: query, params });
      return { values: async () => [] };
    },
  } as unknown as ReturnType<typeof postgres>;
  const db = drizzle({ client, relations });
  for (const query of ["#tag", "keyword"]) {
    const expr = parseQuery(query);
    assert.ok(expr);
    await getSearchPostPage(
      db,
      expr,
      {},
      {
        limit: 6,
        languages: ["ko-KR", "ko"],
      },
    );
    const actual = queries.pop()!;
    assert.equal((actual.sql.match(/"language" in/g) ?? []).length, 1);
    if (query === "#tag")
      assert.match(actual.sql, /left\("d0"\."language", 64\) IN/);
    assert.equal(
      actual.params.filter((value) => value === "ko-KR").length,
      query === "#tag" ? 2 : 1,
    );
    await getSearchPostPage(db, expr, {}, { limit: 6, languages: [] });
    assert.match(queries.pop()!.sql, /false/);
  }
  const expr = parseQuery("#tag lang:ko");
  assert.ok(expr);
  await getSearchPostPage(db, expr, {}, { limit: 6, languages: ["en"] });
  assert.match(queries.pop()!.sql, /false/);
});
