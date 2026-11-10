Language-filtered hashtag search
================================

The final strategy indexes `left(language, 64)`, retains the complete language
in source and derived rows, and rechecks complete source equality before the
page limit. Raw-language alternatives were measured but cannot ship: a valid
9,004-character private-use language on a tagged reply exceeded the B-tree
index-entry limit. Regression tests cover that reply, prefix collisions and
supplementary Unicode near the prefix boundary.

The bounded strategy preserved every compared ordered ID and publication date
and reduced wrong-language source-post lookups. All 1,440 strategy cases
passed: 96 cases × five strategies × three phases, including 1,152 challenger
comparisons against the unchanged deployed selector. Each retained normal
results and three complete
`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)` plans, for 4,320 selector
plans. The default dirty fixture transaction rolled back, and empty
`post`/`actor` tables were verified.

The host runs PostgreSQL 18.6 and Node.js 26.12.1 with `shared_buffers=128MB`
and `work_mem=4MB`. These warm synthetic local results do not establish
PostgreSQL 17 behavior or production speedup. Each dirty and committed run used
a newly created disposable database with the final migrations. The committed
run disabled fixture-table autovacuum, measured before `VACUUM`, ran
`VACUUM (ANALYZE)` outside a transaction, then measured again. All selector
strategies ran before write probes so writes did not change visibility state
for later read strategies.

The 100,000-post fixture has 1,000 actors, visibility restrictions, blocks,
accepted/pending follows, mentions, censorship and suspensions. Its newest
probe population is 1,440 English posts followed by 40 Korean posts, including
regional locales. Probe posts are visible public originals. The 96-case matrix
covers both viewers, limits 6/26, first/later pages,
multiple/missing/unrestricted languages, popular/sparse/missing tags,
required-tag intersections, and bounded/unbounded expression languages.
Publication timestamps are distinct.

The five mutually exclusive indexes are the original ordered baseline, raw
language-leading, raw `INCLUDE`, raw trailing-key and final bounded
trailing-key. Baseline uses a frozen old selector without derived-language
filtering. Raw challengers use the previous raw-language candidate predicate,
including necessary expression-language bounds. Only bounded-trailing calls the
actual final `getSearchPostPage()` helper. Every path retains exact source
expression, visibility and language checks.


Korean skew results
-------------------

Main source index probes count main-post alias `f0` index-scan loops, including
`post_id_actor_id_unique` when chosen instead of `post_pkey`. Full plans retain
the individual index names and all other source scan work. The separate
`sourcePostPkProbes` field remains PK-only. Timings are medians of three
explained runs.

| Phase                   | Viewer | Limit | Baseline ms | Bounded ms | Main source probes before → after | Shared hits before → after |
| ----------------------- | ------ | ----: | ----------: | ---------: | --------------------------------: | -------------------------: |
| dirty                   | guest  |     6 |       2.101 |      0.128 |                          1446 → 6 |                  5836 → 58 |
| dirty                   | guest  |    26 |       1.972 |      0.287 |                         1466 → 26 |                 5976 → 198 |
| dirty                   | signed |     6 |       2.332 |      0.183 |                         1480 → 40 |                 5959 → 182 |
| dirty                   | signed |    26 |       1.949 |      0.176 |                         1480 → 40 |                 5959 → 182 |
| committed-before-vacuum | guest  |     6 |       4.107 |      0.132 |                          1446 → 6 |                  5836 → 58 |
| committed-before-vacuum | guest  |    26 |       2.391 |      0.152 |                         1466 → 26 |                 5976 → 198 |
| committed-before-vacuum | signed |     6 |       3.077 |      0.209 |                         1480 → 40 |                 5959 → 182 |
| committed-before-vacuum | signed |    26 |       3.505 |      0.190 |                         1480 → 40 |                 5959 → 182 |
| committed-after-vacuum  | guest  |     6 |       1.973 |      0.105 |                          1446 → 6 |                  5816 → 58 |
| committed-after-vacuum  | guest  |    26 |       2.153 |      0.155 |                         1466 → 26 |                 5956 → 198 |
| committed-after-vacuum  | signed |     6 |       2.441 |      0.321 |                         1480 → 40 |                 5939 → 182 |
| committed-after-vacuum  | signed |    26 |       2.274 |      0.281 |                         1480 → 40 |                 5939 → 182 |

The bounded membership plan uses a regular `Index Scan` both before and after
`VACUUM`. It does not report a `Heap Fetches` counter and must not be described
as index-only or as having zero heap access. Its expression index condition
rejects wrong-language memberships before the source lookup. The baseline's
index-only membership scan fetched 1,446 heaps before `VACUUM` and zero after
`VACUUM` in the guest six-row case, while still requiring 1,446 source probes.
The bounded query required six source probes in both states.

The guest Korean bounded scan reported one index search. This post-probe
reduction does not need a skip-scan explanation, but PostgreSQL 18 plans cannot
verify PostgreSQL 17 performance. Neither six emitted memberships nor one
reported search proves that only six index entries were visited: trailing
constraints can reject entries inside the index without exposing a
rejected-entry count.


Index comparison and remaining scan work
----------------------------------------

Fresh committed fixture before `VACUUM`, guest first page, limit 6:

| Strategy         | Korean skew ms | English skew ms | Popular Korean ms | Secondary index bytes |
| ---------------- | -------------: | --------------: | ----------------: | --------------------: |
| baseline         |          4.107 |           0.047 |             2.296 |               3055616 |
| language-leading |          0.216 |           5.040 |            13.745 |               3514368 |
| `INCLUDE`        |          0.304 |           6.988 |             0.179 |               3506176 |
| trailing-key     |          0.107 |           0.057 |             0.170 |               3506176 |
| bounded-trailing |          0.132 |           0.047 |             0.088 |               3506176 |

All three ordered language-bearing indexes occupy 3,506,176 bytes in this
short-locale fixture, compared with 3,055,616 bytes for the old index and
3,514,368 for raw language-leading. Before write probes, the derived relation
occupies 3,940,352 bytes. The bounded key adds a fixed character limit to index
storage; the fixture size comparison is not a worst-case size bound.

The language-leading index can sort the entire language population to restore
global date order. Signed-in actor planning can still force source probes for
all 40 Korean probe candidates despite limit 6. Broad multilingual and
unrestricted searches retain that planning cost. Missing-language requests can
scan the complete derived relation. This change reduces wrong-language source
lookups; it does not bound all selector work.


Write observations
------------------

The five 1,000-row operations are insert, same-value language update, changed
language, changed publication date and changed tags. They run after all read
comparisons and roll back to savepoints. All strategies use the migrated
language-aware trigger; “baseline” here means old secondary index, not old
synchronization behavior. Fixed order, physical pages and full-page images
prevent interpreting these observations as stable throughput or incremental
trigger overhead. WAL below is the root plan node counter, not cluster WAL.

| Operation          | Old index ms | Bounded index ms | Old index plan WAL MiB | Bounded index plan WAL MiB |
| ------------------ | -----------: | ---------------: | ---------------------: | -------------------------: |
| insert             |       99.596 |           81.019 |                  2.380 |                      2.304 |
| unchanged-language |       71.974 |           79.288 |                  2.395 |                      2.373 |
| changed-language   |       68.629 |           80.331 |                  2.368 |                      2.377 |
| changed-date       |       79.476 |           88.680 |                  2.386 |                      2.376 |
| changed-tags       |       95.964 |          111.032 |                  2.435 |                      2.456 |

Same-value updates invoke no hashtag synchronization trigger. Changed-language,
changed-date and changed-tags operations each invoke it 1,000 times. Trigger
durations are unavailable with `TIMING OFF`; full trigger call records remain
in JSON.


Reproduction and evidence
-------------------------

Apply current migrations to a fresh empty disposable database, then run:

~~~~ sh
HASHTAG_LANGUAGE_BENCHMARK_DATABASE_URL=postgresql:///YOUR_EMPTY_DB \
  mise exec -- node --import temporal-polyfill/global \
  scripts/benchmark-hashtag-language.ts --posts 100000 > /tmp/hashtag-language-dirty.json
~~~~

Use another fresh empty database for the committed visibility comparison:

~~~~ sh
HASHTAG_LANGUAGE_BENCHMARK_DATABASE_URL=postgresql:///YOUR_OTHER_EMPTY_DB \
  mise exec -- node --import temporal-polyfill/global \
  scripts/benchmark-hashtag-language.ts --posts 100000 --vacuum > /tmp/hashtag-language-vacuum.json
~~~~

The script never reads `DATABASE_URL`. It checks empty `post`/`actor` tables
under write locks before seeding. The `--vacuum` mode commits the fixture and
disables its table autovacuum; dispose of that database afterwards.

Raw SQL, bound parameters, ordered results and plans were retained outside the
checkout as *benchmark-v2-dirty.json* and *benchmark-v2-vacuum.json*. The
main-source-index summary was derived from retained plan nodes after observing
the planner's alternative source index. The frozen selector mirrors
*models/search-query.ts* at 0bdfbafea98e99cbc54a7d8070dc34091a66886c.
Reproduction requires the complete filters; a membership-only query does not
measure this change.


Migration rehearsal
-------------------

The actual `drizzle-kit migrate` runner first applied all 172 previous
migrations to a disposable database and seeded 20,000 posts with three tags
each. An existing tagged reply with a valid 9,004-character BCP 47 private-use
language was accepted by the old schema. The final bounded-expression upgrade
preserved that value exactly in all three memberships, with zero source/derived
language or date mismatches across 60,003 memberships. A fresh database also
passed all 173 migrations from scratch.

Raw old-writer inserts, language-only changes, transitions through SQL `NULL`,
and combined tag/date/language changes preserved the complete long values,
including two languages sharing the same 64-character prefix. An older writer
committing while migration waited for its source lock and a writer queued
behind it both left consistent memberships. A queued hashtag reader completed
after migration released its derived-table lock.

The five-second derived-table lock timeout (`55P03`), a reader-then-writer
deadlock (`40P01`), and an 80 ms statement timeout interrupting the backfill
(`57014`) each rolled back completely. Comparisons covered migration receipts,
column definitions, function and trigger definitions, indexes and a digest of
all derived rows. Each retry succeeded, including exact preservation of the
existing long language. Different deadlock-detection intervals made the
migration the victim in the deadlock test.

The successful upgrade took 1.276 seconds including CLI startup. Samples at
approximately 5 ms intervals observed a 228.9 ms span holding
`ShareRowExclusiveLock` on `post` and `AccessExclusiveLock` on `post_hashtag`;
no source `AccessExclusiveLock` appeared. This sampled span is not an exact
lock-duration bound or an estimate of production downtime.

| Derived storage, bytes                     |     Before |      After | After `VACUUM (ANALYZE)` |
| ------------------------------------------ | ---------: | ---------: | -----------------------: |
| Heap main fork                             |  4,104,192 |  7,159,808 |                7,159,808 |
| Primary-key index main fork                |  3,866,624 |  4,857,856 |                4,857,856 |
| Ordered secondary index main fork          |  6,266,880 |  6,791,168 |                6,791,168 |
| Total relation including auxiliary storage | 14,270,464 | 18,915,328 |               18,923,520 |

The total includes auxiliary forks and TOAST storage for the long language.
Maintenance did not shrink the heap or indexes; total storage grew another
8,192 bytes. The fixture's insertion order and index occupancy affect these
figures, so they are not per-row production estimates.

The cluster WAL insertion position advanced by 80,379,848 bytes during the
successful invocation. Other local workers were active: this is an upper
bound on migration-attributable WAL, not an isolated measurement of migration
WAL cost.

The schema and snapshot were generated together before replacing the SQL with
its atomic backfill and synchronization block. A subsequent
`drizzle-kit generate` reported no schema changes. Drizzle directly represents
the trailing expression key. PostgreSQL documents the distinction between
[checking later index columns] and narrowing the scanned range, and the
[expression-index limitations] affecting index-only plans.

[checking later index columns]: https://www.postgresql.org/docs/17/indexes-multicolumn.html
[expression-index limitations]: https://www.postgresql.org/docs/17/indexes-index-only-scans.html
