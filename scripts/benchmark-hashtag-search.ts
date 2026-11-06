/** Run only against an explicitly selected, fully migrated empty database. */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import type { RelationsFilter } from "../models/db.ts";
import {
  getCensoredPostExclusionFilter,
  getPostVisibilityFilter,
} from "../models/post/visibility.ts";
import type { Expr } from "../models/search.ts";
import { compileQuery, getSearchPostPage } from "../models/search-query.ts";
import { createDatabaseResources } from "../runtime/resources.ts";

const { values } = parseArgs({
  options: { posts: { type: "string", default: "100000" } },
});
const posts = Number(values.posts);
assert(
  Number.isSafeInteger(posts) && posts >= 1000,
  "--posts must be an integer >= 1000",
);
const url = process.env.HASHTAG_BENCHMARK_DATABASE_URL;
assert(
  url,
  "Set HASHTAG_BENCHMARK_DATABASE_URL explicitly to an empty, migrated benchmark database",
);
type Query = { sql: string; params: unknown[] };
let emitted: Query[] | undefined;
const { db: database, postgres: client } = createDatabaseResources({ url });
client.options.debug = (_connection, query, parameters) => {
  emitted?.push({ sql: query, params: [...parameters] });
};
const rollback = new Error("Rollback benchmark fixture");
const report: Record<string, unknown> = { posts, runs: 3, results: [] };
try {
  await database.transaction(async (db) => {
    const connection = Object.assign(
      (strings: TemplateStringsArray, ...parameters: unknown[]) =>
        db.execute(sql(strings, ...parameters)),
      {
        unsafe(query: string, parameters: unknown[] = []) {
          // Preserve bound values when explaining the exact emitted SQL.
          const chunks = query
            .split(/(\$[0-9]+)/g)
            .map((chunk) =>
              /^\$[0-9]+$/.test(chunk)
                ? sql`${parameters[Number(chunk.slice(1)) - 1]}`
                : sql.raw(chunk),
            );
          return db.execute(sql.join(chunks, sql``));
        },
      },
    );
    // Serialize the emptiness check and fixture writes with concurrent writers.
    await connection`LOCK TABLE post, actor IN SHARE ROW EXCLUSIVE MODE`;
    const [counts] =
      await connection`SELECT (SELECT count(*) FROM post) posts, (SELECT count(*) FROM actor) actors`;
    assert.equal(
      Number(counts.posts),
      0,
      "Benchmark requires empty post table",
    );
    assert.equal(
      Number(counts.actors),
      0,
      "Benchmark requires empty actor table",
    );
    const [version] =
      await connection`SELECT version(), current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem`;
    report.environment = version;
    const seedStart = performance.now();
    await connection`INSERT INTO instance(host,software,software_version) VALUES('hashtag-bench.invalid','benchmark','1')`;
    await connection`INSERT INTO actor(id,iri,type,username,instance_host,handle_host,name,followers_count,followees_count,inbox_url,suspended)
      SELECT md5('actor'||i)::uuid,'https://hashtag-bench.invalid/users/'||i,'Person','user'||i,'hashtag-bench.invalid','hashtag-bench.invalid','User '||i,0,0,'https://hashtag-bench.invalid/users/'||i||'/inbox',CASE WHEN i%101=0 THEN '2025-01-01'::timestamptz END FROM generate_series(1,1000) i`;
    await connection`INSERT INTO following(follower_id,followee_id,iri,accepted)
      SELECT md5('actor1')::uuid,md5('actor'||i)::uuid,'https://hashtag-bench.invalid/follows/'||i, CASE WHEN i%3<>0 THEN '2025-01-01'::timestamptz END FROM generate_series(2,1000,7) i`;
    await connection`INSERT INTO blocking(id,iri,blocker_id,blockee_id)
      SELECT md5('block'||i)::uuid,'https://hashtag-bench.invalid/blocks/'||i,md5('actor1')::uuid,md5('actor'||i)::uuid FROM generate_series(2,1000,31) i`;
    await connection`INSERT INTO post(id,iri,type,actor_id,content_html,published,updated,visibility,language,censored,tags)
      SELECT md5('post'||i)::uuid,'https://hashtag-bench.invalid/posts/'||i,'Note',md5('actor'||(1+i%1000))::uuid,
      '<p>'||CASE WHEN i%3=0 THEN 'needle ' ELSE '' END||repeat('body ',100)||'</p>',
      '2026-01-01'::timestamptz+i*interval '1 second','2026-01-01'::timestamptz+i*interval '1 second',
      (CASE WHEN i%10<7 THEN 'public' WHEN i%10=7 THEN 'unlisted' WHEN i%10=8 THEN 'followers' ELSE 'direct' END)::post_visibility,
      CASE WHEN i%11=0 THEN 'en' WHEN i%19=0 THEN NULL ELSE 'ko' END,
      CASE WHEN i%17=0 THEN '2025-01-01'::timestamptz END,
      (CASE WHEN i%2=0 THEN '{"popular":"url"}'::jsonb ELSE '{}'::jsonb END)||
      (CASE WHEN i%10007=0 THEN '{"sparse":"url"}'::jsonb ELSE '{}'::jsonb END)||
      (CASE WHEN i<100 AND i%3=0 THEN '{"oldrare":"url"}'::jsonb ELSE '{}'::jsonb END)||
      (CASE WHEN i%13=0 THEN '{"second":"url"}'::jsonb ELSE '{}'::jsonb END)
      FROM generate_series(1,${posts}) i`;
    await connection`INSERT INTO mention(post_id,actor_id) SELECT md5('post'||i)::uuid,md5('actor1')::uuid FROM generate_series(113,${posts},113) i`;
    report.seedMs = performance.now() - seedStart;
    for (const table of [
      "post",
      "actor",
      "following",
      "blocking",
      "mention",
      "post_hashtag",
    ]) {
      await connection.unsafe(`ANALYZE ${table}`);
    }
    report.storage =
      await connection`SELECT pg_table_size('post_hashtag') heap_bytes, pg_indexes_size('post_hashtag') index_bytes, pg_table_size('post') post_heap_bytes, pg_indexes_size('post') post_index_bytes, (SELECT count(*) FROM post_hashtag) memberships`;
    const viewer = await db.query.actorTable.findFirst({
      where: { username: "user1" },
    });
    assert(viewer);
    const hashtag = (hashtag: string): Expr => ({ type: "hashtag", hashtag });
    const expressions: [string, Expr][] = [
      ...["popular", "sparse", "oldrare", "missing"].map(
        (tag): [string, Expr] => [tag, hashtag(tag)],
      ),
      [
        "popular AND sparse",
        { type: "and", left: hashtag("popular"), right: hashtag("sparse") },
      ],
      [
        "sparse AND popular",
        { type: "and", left: hashtag("sparse"), right: hashtag("popular") },
      ],
    ];
    /**
     * Compile the unfenced JSONB alternative for benchmark comparisons.
     * Keep conjunctions recursive so tag intersections have the same semantics
     * as the production compiler without its materialized membership lookup.
     */
    function direct(expr: Expr): RelationsFilter<"postTable"> {
      if (expr.type === "hashtag")
        return { RAW: (t) => sql`${t.tags} ? ${expr.hashtag.toLowerCase()}` };
      if (expr.type === "and")
        return { AND: [direct(expr.left), direct(expr.right)] };
      return compileQuery(expr);
    }
    for (const signed of [false, true]) {
      for (const language of ["ko", "en", "missing", "any"]) {
        for (const [expression, expr] of expressions) {
          // High rejection cases need the common popular tag, not a redundant full matrix.
          if (language !== "ko" && expression !== "popular") continue;
          for (const page of ["first", "later"]) {
            const until =
              page === "first"
                ? undefined
                : new Date(
                    Date.parse("2026-01-01T00:00:00Z") +
                      Math.floor(posts / 2) * 1000,
                  );
            const common: RelationsFilter<"postTable"> = {
              AND: [
                getPostVisibilityFilter(signed ? viewer : null),
                ...(signed
                  ? []
                  : [
                      {
                        visibility: "public",
                      } satisfies RelationsFilter<"postTable">,
                    ]),
                getCensoredPostExclusionFilter(signed ? viewer.id : null),
                { sharedPostId: { isNull: true } },
                language === "any" ? {} : { language },
              ],
            };
            const generic = async (filter: RelationsFilter<"postTable">) =>
              await db.query.postTable.findMany({
                columns: { id: true },
                where: {
                  AND: [
                    common,
                    filter,
                    until ? { published: { lte: until } } : {},
                  ],
                },
                orderBy: { published: "desc" },
                limit: 26,
              });
            let baseline: string[] | undefined;
            for (const strategy of ["materialized", "direct", "ordered"]) {
              emitted = [];
              const rows =
                strategy === "ordered"
                  ? await getSearchPostPage(db, expr, common, {
                      limit: 26,
                      until,
                    })
                  : await generic(
                      strategy === "materialized"
                        ? compileQuery(expr)
                        : direct(expr),
                    );
              const captured = emitted;
              emitted = undefined;
              assert.equal(
                captured.length,
                1,
                "Expected exactly one emitted page query",
              );
              const query = captured[0];
              const ids = rows.map((row) => row.id);
              if (baseline == null) baseline = ids;
              else
                assert.deepEqual(
                  ids,
                  baseline,
                  JSON.stringify({
                    signed,
                    language,
                    expression,
                    page,
                    strategy,
                  }),
                );
              const plans: Record<string, unknown>[] = [];
              for (let run = 0; run < 3; run++) {
                const result = await connection.unsafe(
                  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
                  query.params,
                );
                plans.push(
                  (result[0]["QUERY PLAN"] as Record<string, unknown>[])[0],
                );
              }
              const times = plans
                .map((plan) => Number(plan["Execution Time"]))
                .sort((a, b) => a - b);
              (report.results as unknown[]).push({
                signed,
                language,
                expression,
                page,
                strategy,
                ids,
                equalToBaseline: true,
                medianMs: times[1],
                ...query,
                plans,
              });
              console.error(
                JSON.stringify({
                  signed,
                  language,
                  expression,
                  page,
                  strategy,
                  medianMs: times[1],
                  rows: ids.length,
                }),
              );
            }
          }
        }
      }
    }
    // EXPLAIN executes each update. Savepoints restore fixture contents while
    // retaining the plans and WAL counters from the attempted writes.
    const writes = [];
    for (const triggers of [true, false]) {
      await connection`SAVEPOINT benchmark_write`;
      if (!triggers) {
        await connection`ALTER TABLE post DISABLE TRIGGER trg_insert_post_hashtags`;
        await connection`ALTER TABLE post DISABLE TRIGGER trg_update_post_hashtags`;
      }
      for (const change of ["unchanged", "tags", "published"]) {
        const assignment =
          change === "unchanged"
            ? "tags = tags"
            : change === "tags"
              ? `tags = tags || '{"write-probe":"url"}'::jsonb`
              : "published = published + interval '1 second'";
        const result = await connection.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) UPDATE post SET ${assignment} WHERE id IN (SELECT id FROM post ORDER BY id LIMIT 1000)`,
        );
        writes.push({
          triggers,
          change,
          plan: (result[0]["QUERY PLAN"] as Record<string, unknown>[])[0],
        });
      }
      const inserted =
        await connection.unsafe(`EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)
        INSERT INTO post(id,iri,type,actor_id,content_html,published,updated,visibility,language,tags)
        SELECT md5('write-probe'||id)::uuid, iri||'/write-probe', type, actor_id, content_html,
          published, updated, visibility, language, tags FROM post ORDER BY id LIMIT 1000`);
      writes.push({
        triggers,
        change: "insert",
        plan: (inserted[0]["QUERY PLAN"] as Record<string, unknown>[])[0],
      });
      await connection`ROLLBACK TO SAVEPOINT benchmark_write`;
      await connection`RELEASE SAVEPOINT benchmark_write`;
    }
    report.writes = writes;
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
  report.rolledBack = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.end();
}
