/**
 * Compare #461 against the pre-change ordered selector on a disposable database.
 * The URL must be explicit; DATABASE_URL is never selected. Default mode rolls
 * back all fixture rows. --vacuum commits the fixture and leaves it for database
 * disposal, measuring again after VACUUM outside a transaction.
 */
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import type { RelationsFilter, Transaction } from "../models/db.ts";
import {
  getCensoredPostExclusionFilter,
  getPostVisibilityFilter,
} from "../models/post/visibility.ts";
import { postHashtagTable } from "../models/schema.ts";
import { parseQuery, type Expr } from "../models/search.ts";
import {
  compileQuery,
  getRequiredHashtags,
  getRequiredLanguages,
  getSearchPostPage,
} from "../models/search-query.ts";
import { createDatabaseResources } from "../runtime/resources.ts";

const { values } = parseArgs({
  options: {
    posts: { type: "string", default: "100000" },
    runs: { type: "string", default: "3" },
    vacuum: { type: "boolean", default: false },
  },
});
const posts = Number(values.posts);
const runs = Number(values.runs);
assert(Number.isSafeInteger(posts) && posts >= 5000, "--posts must be >= 5000");
assert(Number.isSafeInteger(runs) && runs >= 1 && runs <= 10);
const url = process.env.HASHTAG_LANGUAGE_BENCHMARK_DATABASE_URL;
assert(
  url,
  "Set HASHTAG_LANGUAGE_BENCHMARK_DATABASE_URL to an empty disposable database",
);
type Query = { sql: string; params: unknown[] };
interface PlanNode {
  [key: string]: unknown;
  Plans?: PlanNode[];
}
let emitted: Query[] | undefined;
const { db: database, postgres: client } = createDatabaseResources({ url });
client.options.debug = (_connection, query, parameters) => {
  emitted?.push({ sql: query, params: [...parameters] });
};
const rollback = new Error("Rollback benchmark fixture");
const report: Record<string, unknown> = {
  posts,
  runs,
  comparison:
    "pre-change baseline, three raw-language challengers, final bounded-key helper",
  mode: values.vacuum ? "committed-before-and-after-vacuum" : "rollback-dirty",
  caveats: [
    "PostgreSQL 18 plans do not establish PostgreSQL 17 behavior; inspect skip-scan dependence.",
    "Warm synthetic execution times do not predict production latency.",
    "Index conditions can reject tuples without reporting a tuple count; observed membership rows are a lower bound on index work.",
    "WAL plan counters omit some trigger work; write probes are not throughput estimates.",
    "All write probes use the migrated language-aware triggers; baseline denotes the old secondary index, not the old trigger implementation.",
  ],
  phases: [],
};

function execute(db: Transaction, query: string, parameters: unknown[] = []) {
  const chunks = query
    .split(/(\$[0-9]+)/g)
    .map((chunk) =>
      /^\$[0-9]+$/.test(chunk)
        ? sql`${parameters[Number(chunk.slice(1)) - 1]}`
        : sql.raw(chunk),
    );
  return db.execute(sql.join(chunks, sql``));
}

/**
 * Frozen ordered selector from the pre-#461 models/search-query.ts snapshot.
 * Only the selector is copied: compileQuery/getRequiredHashtags retain their
 * unchanged exact-expression semantics. Explicit languages remain on post.
 * Optional raw candidate languages reproduce the pre-bounded-key challengers.
 */
async function legacyPage(
  db: Transaction,
  expr: Expr,
  commonFilter: RelationsFilter<"postTable">,
  options: { limit: number; until?: Date; rawCandidateLanguages?: string[] },
) {
  const hashtags = getRequiredHashtags(expr);
  const where: RelationsFilter<"postTable"> = {
    AND: [
      commonFilter,
      compileQuery(expr, hashtags.length > 0),
      options.until == null ? {} : { published: { lte: options.until } },
    ],
  };
  if (hashtags.length < 1) {
    return db.query.postTable.findMany({
      columns: { id: true, published: true },
      where,
      orderBy: { published: "desc" },
      limit: options.limit,
    });
  }
  const page = await db.query.postHashtagTable.findMany({
    columns: { postId: true, published: true },
    where: {
      AND: [
        { RAW: (t) => sql`${t.tagHash} = md5(${hashtags[0]})::uuid` },
        options.rawCandidateLanguages == null
          ? {}
          : { language: { in: options.rawCandidateLanguages } },
        ...hashtags.slice(1).map(
          (tag): RelationsFilter<"postHashtagTable"> => ({
            RAW: (t) =>
              sql`${t.postId} IN (SELECT ${postHashtagTable.postId} FROM ${postHashtagTable} WHERE ${postHashtagTable.tagHash} = md5(${tag})::uuid)`,
          }),
        ),
        options.until == null ? {} : { published: { lte: options.until } },
        { post: where },
      ],
    },
    orderBy: { published: "desc" },
    limit: options.limit,
  });
  return page.map(({ postId, published }) => ({ id: postId, published }));
}

async function seed(db: Transaction) {
  await db.execute(sql`LOCK TABLE post, actor IN SHARE ROW EXCLUSIVE MODE`);
  const [counts] = await db.execute(
    sql`SELECT (SELECT count(*) FROM post) posts, (SELECT count(*) FROM actor) actors, (SELECT count(*) FROM instance WHERE host = 'hashtag-language-bench.invalid') instances`,
  );
  assert.equal(Number(counts.posts), 0, "Benchmark requires empty post");
  assert.equal(Number(counts.actors), 0, "Benchmark requires empty actor");
  assert.equal(
    Number(counts.instances),
    0,
    "Benchmark fixture instance exists",
  );
  if (values.vacuum) {
    // Keep the before/after transition under harness control. These settings
    // remain with the committed fixture, which must be disposed of afterwards.
    await execute(db, "ALTER TABLE post SET (autovacuum_enabled=false)");
    await execute(
      db,
      "ALTER TABLE post_hashtag SET (autovacuum_enabled=false)",
    );
  }
  const [environment] = await db.execute(
    sql`SELECT version(), current_setting('shared_buffers') shared_buffers, current_setting('work_mem') work_mem, current_setting('block_size') block_size`,
  );
  report.environment = environment;
  const start = performance.now();
  await db.execute(
    sql`INSERT INTO instance(host,software,software_version) VALUES('hashtag-language-bench.invalid','benchmark','1')`,
  );
  await db.execute(sql`INSERT INTO actor(id,iri,type,username,instance_host,handle_host,name,followers_count,followees_count,inbox_url,suspended)
    SELECT md5('language-actor'||i)::uuid,'https://hashtag-language-bench.invalid/users/'||i,'Person','languageuser'||i,'hashtag-language-bench.invalid','hashtag-language-bench.invalid','User '||i,0,0,'https://hashtag-language-bench.invalid/users/'||i||'/inbox',CASE WHEN i%101=0 THEN '2025-01-01'::timestamptz END FROM generate_series(1,1000) i`);
  await db.execute(sql`INSERT INTO following(follower_id,followee_id,iri,accepted)
    SELECT md5('language-actor1')::uuid,md5('language-actor'||i)::uuid,'https://hashtag-language-bench.invalid/follows/'||i,CASE WHEN i%3<>0 THEN '2025-01-01'::timestamptz END FROM generate_series(2,1000,7) i`);
  await db.execute(sql`INSERT INTO blocking(id,iri,blocker_id,blockee_id)
    SELECT md5('language-block'||i)::uuid,'https://hashtag-language-bench.invalid/blocks/'||i,md5('language-actor1')::uuid,md5('language-actor'||i)::uuid FROM generate_series(2,1000,31) i`);
  // Newest 1,440 English probe posts precede 40 Korean probe posts. All probe
  // posts are public originals from a visible author, so both limits can fill.
  await db.execute(sql`INSERT INTO post(id,iri,type,actor_id,content_html,published,updated,visibility,language,censored,tags)
    SELECT md5('language-post'||i)::uuid,'https://hashtag-language-bench.invalid/posts/'||i,'Note',
      CASE WHEN i>${posts}-1480 THEN md5('language-actor2')::uuid ELSE md5('language-actor'||(1+i%1000))::uuid END,
      '<p>'||CASE WHEN i%3=0 THEN 'needle ' ELSE '' END||repeat('body ',100)||'</p>',
      '2026-01-01'::timestamptz+i*interval '1 second','2026-01-01'::timestamptz+i*interval '1 second',
      (CASE WHEN i>${posts}-1480 OR i%10<7 THEN 'public' WHEN i%10=7 THEN 'unlisted' WHEN i%10=8 THEN 'followers' ELSE 'direct' END)::post_visibility,
      CASE WHEN i>${posts}-1440 THEN CASE WHEN i%2=0 THEN 'en' ELSE 'en-US' END WHEN i>${posts}-1480 THEN CASE WHEN i%2=0 THEN 'ko' ELSE 'ko-KR' END WHEN i%19=0 THEN NULL WHEN i%11=0 THEN 'en' WHEN i%7=0 THEN 'ko-KR' ELSE 'ko' END,
      CASE WHEN i<=${posts}-1480 AND i%17=0 THEN '2025-01-01'::timestamptz END,
      (CASE WHEN i%2=0 THEN '{"popular":"url"}'::jsonb ELSE '{}'::jsonb END)||
      (CASE WHEN i%10007=0 THEN '{"sparse":"url"}'::jsonb ELSE '{}'::jsonb END)||
      (CASE WHEN i>${posts}-1480 THEN '{"languageprobe":"url"}'::jsonb ELSE '{}'::jsonb END)
      FROM generate_series(1,${posts}) i`);
  await db.execute(
    sql`INSERT INTO mention(post_id,actor_id) SELECT md5('language-post'||i)::uuid,md5('language-actor1')::uuid FROM generate_series(113,${posts},113) i`,
  );
  for (const table of [
    "post",
    "actor",
    "following",
    "blocking",
    "mention",
    "post_hashtag",
  ])
    await execute(db, `ANALYZE ${table}`);
  report.seedMs = performance.now() - start;
  report.fixture = Array.from(
    await db.execute(
      sql`SELECT p.language,count(*) FROM post p WHERE p.tags ? 'languageprobe' GROUP BY p.language ORDER BY p.language`,
    ),
  );
}

function summarize(plan: Record<string, unknown>) {
  const nodes: Record<string, unknown>[] = [];
  function visit(node: PlanNode) {
    const loops = Number(node["Actual Loops"] ?? 0);
    if (
      node["Relation Name"] === "post" ||
      node["Relation Name"] === "post_hashtag"
    )
      nodes.push({
        type: node["Node Type"],
        relation: node["Relation Name"],
        alias: node.Alias,
        index: node["Index Name"],
        loops,
        returned: Number(node["Actual Rows"] ?? 0) * loops,
        filtered: Number(node["Rows Removed by Filter"] ?? 0) * loops,
        heapFetches: node["Heap Fetches"],
        indexSearches: node["Index Searches"],
        indexCondition: node["Index Cond"],
        filter: node.Filter,
      });
    for (const child of node.Plans ?? []) visit(child);
  }
  const root = plan.Plan as PlanNode;
  visit(root);
  return {
    planningMs: plan["Planning Time"],
    executionMs: plan["Execution Time"],
    sharedHits: root["Shared Hit Blocks"],
    sharedReads: root["Shared Read Blocks"],
    tempRead: root["Temp Read Blocks"],
    tempWritten: root["Temp Written Blocks"],
    postPkProbes: nodes
      .filter((node) => node.index === "post_pkey")
      .reduce((sum, node) => sum + Number(node.loops), 0),
    sourcePostPkProbes: nodes
      .filter((node) => node.index === "post_pkey" && node.alias === "f0")
      .reduce((sum, node) => sum + Number(node.loops), 0),
    // The planner can use the (id, actor_id) unique index instead of post_pkey.
    sourcePostIndexProbes: nodes
      .filter((node) => node.alias === "f0" && typeof node.index === "string")
      .reduce((sum, node) => sum + Number(node.loops), 0),
    nodes,
  };
}

const indexes = [
  ["baseline", '("tag_hash", "published" DESC, "post_id")'],
  ["language-leading", '("tag_hash", "language", "published" DESC, "post_id")'],
  ["include", '("tag_hash", "published" DESC, "post_id") INCLUDE ("language")'],
  ["trailing-key", '("tag_hash", "published" DESC, "post_id", "language")'],
  [
    "bounded-trailing",
    '("tag_hash", "published" DESC, "post_id", (left("language", 64)))',
  ],
] as const;

async function measure(db: Transaction, phaseName: string) {
  const viewer = await db.query.actorTable.findFirst({
    where: { username: "languageuser1" },
  });
  assert(viewer);
  const definitions: { name: string; query: string; languages?: string[] }[] = [
    { name: "skew-ko", query: "#languageprobe", languages: ["ko", "ko-KR"] },
    { name: "skew-en", query: "#languageprobe", languages: ["en", "en-US"] },
    {
      name: "skew-multiple",
      query: "#languageprobe",
      languages: ["ko", "ko-KR", "en", "en-US"],
    },
    { name: "popular-ko", query: "#popular", languages: ["ko", "ko-KR"] },
    {
      name: "popular-missing-language",
      query: "#popular",
      languages: ["ja", "ja-JP"],
    },
    { name: "popular-unrestricted", query: "#popular" },
    { name: "sparse-ko", query: "#sparse", languages: ["ko", "ko-KR"] },
    { name: "missing-tag", query: "#missing", languages: ["ko", "ko-KR"] },
    {
      name: "intersection",
      query: "#popular #sparse",
      languages: ["ko", "ko-KR"],
    },
    { name: "expression-language", query: "#popular lang:ko" },
    { name: "expression-bounded-or", query: "#popular (lang:ko OR lang:en )" },
    { name: "expression-unbounded-or", query: "#popular (lang:ko OR needle )" },
  ];
  const cases = [false, true].flatMap((signed) =>
    definitions.flatMap((definition) =>
      [6, 26].flatMap((limit) =>
        ["first", "later"].map((page) => {
          // Keep the Korean probe tail reachable on a later skew page.
          const seconds = definition.name.startsWith("skew")
            ? posts - 1450
            : Math.floor(posts / 2);
          const until =
            page === "first"
              ? undefined
              : new Date(Date.parse("2026-01-01T00:00:00Z") + seconds * 1000);
          const expr = parseQuery(definition.query);
          assert(expr);
          const common: RelationsFilter<"postTable"> = {
            AND: [
              getPostVisibilityFilter(signed ? viewer : null),
              ...(signed ? [] : [{ visibility: "public" } as const]),
              getCensoredPostExclusionFilter(signed ? viewer.id : undefined),
              { sharedPostId: { isNull: true } },
            ],
          };
          return { ...definition, signed, limit, page, until, expr, common };
        }),
      ),
    ),
  );
  const expected = new Map<string, unknown>();
  const results: Record<string, unknown>[] = [];
  const writeProbes: Record<string, unknown>[] = [];
  const storage: Record<string, unknown>[] = [];
  for (const [strategy, columns] of indexes) {
    process.stderr.write(`Measuring ${phaseName}: ${strategy}\n`);
    await execute(db, "SAVEPOINT language_index");
    await execute(db, 'DROP INDEX "idx_post_hashtag_tag_published"');
    const buildStart = performance.now();
    await execute(
      db,
      `CREATE INDEX "idx_post_hashtag_tag_published" ON "post_hashtag" ${columns}`,
    );
    const [sizes] = await db.execute(
      sql`SELECT pg_table_size('post_hashtag') heap_bytes, pg_relation_size('idx_post_hashtag_tag_published') secondary_bytes, pg_indexes_size('post_hashtag') all_index_bytes, pg_get_indexdef('idx_post_hashtag_tag_published'::regclass) definition`,
    );
    storage.push({
      strategy,
      buildMs: performance.now() - buildStart,
      ...sizes,
    });
    for (const item of cases) {
      const { name, signed, limit, page, until, expr, common, languages } =
        item;
      const key = JSON.stringify({ name, signed, limit, page });
      emitted = [];
      const requiredLanguages = getRequiredLanguages(expr);
      const rawCandidateLanguages =
        strategy === "baseline"
          ? undefined
          : languages == null
            ? requiredLanguages
            : requiredLanguages == null
              ? languages
              : languages.filter((language) =>
                  requiredLanguages.includes(language),
                );
      const rows =
        strategy === "bounded-trailing"
          ? await getSearchPostPage(db, expr, common, {
              limit,
              until,
              languages,
            })
          : await legacyPage(
              db,
              expr,
              {
                AND: [
                  common,
                  languages == null ? {} : { language: { in: languages } },
                ],
              },
              { limit, until, rawCandidateLanguages },
            );
      const queries = emitted;
      emitted = undefined;
      const normalized = rows.map(({ id, published }) => ({
        id,
        published: new Date(published).toISOString(),
      }));
      if (strategy === "baseline") expected.set(key, normalized);
      else
        assert.deepEqual(normalized, expected.get(key), `${strategy} ${key}`);
      assert.equal(queries.length, 1, "Expected one complete selector query");
      const query = queries[0];
      const plans: Record<string, unknown>[] = [];
      for (let run = 0; run < runs; run++) {
        const result = await execute(
          db,
          `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${query.sql}`,
          query.params,
        );
        plans.push((result[0]["QUERY PLAN"] as Record<string, unknown>[])[0]);
      }
      const times = plans
        .map((plan) => Number(plan["Execution Time"]))
        .sort((a, b) => a - b);
      results.push({
        name,
        signed,
        limit,
        page,
        until,
        languages,
        strategy,
        rows: normalized,
        query,
        medianExecutionMs: times[Math.floor(times.length / 2)],
        summaries: plans.map(summarize),
        plans,
      });
    }
    await execute(db, "ROLLBACK TO SAVEPOINT language_index");
    await execute(db, "RELEASE SAVEPOINT language_index");
  }
  // Run writes after ALL selector comparisons so aborted writes cannot clear
  // visibility-map bits or bloat source relations for later read strategies.
  for (const [strategy, columns] of indexes) {
    await execute(db, "SAVEPOINT language_index");
    await execute(db, 'DROP INDEX "idx_post_hashtag_tag_published"');
    await execute(
      db,
      `CREATE INDEX "idx_post_hashtag_tag_published" ON "post_hashtag" ${columns}`,
    );
    for (const [operation, statement] of [
      [
        "insert",
        "INSERT INTO post(id,iri,type,actor_id,content_html,published,updated,visibility,language,tags) SELECT md5(id::text||'writeprobe')::uuid,iri||'/writeprobe',type,actor_id,content_html,published,updated,visibility,language,tags FROM post ORDER BY id LIMIT 1000",
      ],
      [
        "unchanged-language",
        "UPDATE post SET language=language WHERE id IN (SELECT id FROM post ORDER BY id LIMIT 1000)",
      ],
      [
        "changed-language",
        "UPDATE post SET language=CASE WHEN language='en' THEN 'ko' ELSE 'en' END WHERE id IN (SELECT id FROM post ORDER BY id LIMIT 1000)",
      ],
      [
        "changed-date",
        "UPDATE post SET published=published+interval '1 second' WHERE id IN (SELECT id FROM post ORDER BY id LIMIT 1000)",
      ],
      [
        "changed-tags",
        'UPDATE post SET tags=tags||\'{"writeprobe":"url"}\'::jsonb WHERE id IN (SELECT id FROM post ORDER BY id LIMIT 1000)',
      ],
    ]) {
      await execute(db, "SAVEPOINT language_write");
      const result = await execute(
        db,
        `EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, FORMAT JSON) ${statement}`,
      );
      writeProbes.push({
        strategy,
        operation,
        plan: (result[0]["QUERY PLAN"] as unknown[])[0],
      });
      await execute(db, "ROLLBACK TO SAVEPOINT language_write");
      await execute(db, "RELEASE SAVEPOINT language_write");
    }
    await execute(db, "ROLLBACK TO SAVEPOINT language_index");
    await execute(db, "RELEASE SAVEPOINT language_index");
  }
  (report.phases as unknown[]).push({
    name: phaseName,
    cases: cases.length,
    strategies: indexes.length,
    results,
    storage,
    writeProbes,
  });
}

try {
  if (values.vacuum) {
    process.stderr.write(
      "--vacuum commits fixture rows: dispose of this database after measurement.\n",
    );
    await database.transaction(seed);
    // Measurement transactions deliberately roll back index replacements and
    // writes; the committed seed is visible to VACUUM's visibility-map work.
    for (const phase of ["committed-before-vacuum", "committed-after-vacuum"]) {
      if (phase === "committed-after-vacuum") {
        await client.unsafe("VACUUM (ANALYZE) post_hashtag");
        await client.unsafe("VACUUM (ANALYZE) post");
      }
      try {
        await database.transaction(async (db) => {
          await db.execute(
            sql`LOCK TABLE post, actor IN SHARE ROW EXCLUSIVE MODE`,
          );
          await measure(db, phase);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    }
    report.fixtureRetained = true;
  } else {
    try {
      await database.transaction(async (db) => {
        await seed(db);
        await measure(db, "dirty");
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    const [counts] =
      await client`SELECT (SELECT count(*) FROM post) posts, (SELECT count(*) FROM actor) actors`;
    assert.equal(Number(counts.posts), 0);
    assert.equal(Number(counts.actors), 0);
    report.rollbackVerified = true;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await client.end();
}
