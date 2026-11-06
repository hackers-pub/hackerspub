Ordered hashtag search benchmark
================================

The benchmark compares the existing materialized hashtag membership query, a
direct JSONB existence candidate, and `getSearchPostPage()` using the derived
`post_hashtag` relation. Result equality and the emitted query plans are the
primary checks. Timings are warm synthetic measurements on a local PostgreSQL
instance; they do not predict production latency or a production percentile.


Reproduction
------------

Create a fresh separate PostgreSQL database for each dataset size and apply the
current migrations with the project's migration runner. Then run from the
repository root:

~~~~ sh
HASHTAG_BENCHMARK_DATABASE_URL=postgresql://USER@HOST/EMPTY_100K_DB \
  mise exec -- node --import temporal-polyfill/global \
  scripts/benchmark-hashtag-search.ts --posts 100000 > /tmp/hashtag-100k.json
HASHTAG_BENCHMARK_DATABASE_URL=postgresql://USER@HOST/EMPTY_400K_DB \
  mise exec -- node --import temporal-polyfill/global \
  scripts/benchmark-hashtag-search.ts --posts 400000 > /tmp/hashtag-400k.json
~~~~

The harness requires `HASHTAG_BENCHMARK_DATABASE_URL`; it never selects
`DATABASE_URL`. It locks `post` and `actor` before rejecting a nonempty
fixture, then seeds and measures inside one transaction. Success and failure
roll back all fixture rows, write probes, and trigger changes. Aborted writes
can retain physical pages, so recreate the database before another size
comparison. Use a disposable database: the run holds write-blocking locks until
rollback.

The JSON output retains every query captured from the actual PostgreSQL driver,
its bound parameters, returned IDs, and all three
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans. Each strategy first executes
normally for ordered-ID comparison, then records the median execution time from
three explained warm runs. The optimized query comes directly from
`getSearchPostPage()`, including its relation filters; the harness does not
reconstruct it. A mismatch fails the run. No latency threshold controls success.

The fixture has 1,000 actors, accepted and pending follows, blocks, mentions,
public/unlisted/followers/direct posts, censorship, remote suspensions, and
roughly 500-character bodies. Half the posts have `popular`, every 10,007th has
`sparse`, 33 posts in the oldest 100 have `oldrare`, and every 13th has
`second`. Languages are `ko`, `en`, or SQL `NULL`. Publication timestamps
differ by one second, so equality checks do not impose a new timestamp-tie
contract. Later pages use the midpoint of each dataset. All search filters run
before the 26-row page limit.

The matrix covers guest/signed viewers, first/later pages, `popular`, `sparse`,
`oldrare`, and missing tags, both orders of `popular AND sparse`, English,
zero-matching-language, and unrestricted-language popular-tag searches. The
last three language variants supplement the main Korean-language matrix.


Measured results
----------------

The final runs used separate fresh databases on PostgreSQL 17.11, Node.js
26.12.1, a Ryzen 7 7700X host with 16 logical CPUs and 124 GiB reported RAM,
and a container without CPU/memory limits. PostgreSQL used
`shared_buffers = 128MB` and `work_mem = 4MB`. Each size passed all 108
strategy cases, including ordered-ID equality, and rolled back successfully.
Raw plans and parameters were retained outside the checkout.

First-page `popular` search in Korean, median execution time in milliseconds:

| Posts   | Viewer | Materialized | Direct JSONB | Ordered relation |
| ------- | ------ | -----------: | -----------: | ---------------: |
| 100,000 | Guest  |       95.217 |        0.074 |            4.444 |
| 100,000 | Signed |      353.225 |      301.882 |            0.203 |
| 400,000 | Guest  |      383.196 |        0.070 |           16.966 |
| 400,000 | Signed |      667.123 |    10247.155 |            0.264 |

Selected 400,000-post signed-viewer cases, also in milliseconds. Korean is used
unless shown otherwise:

| Query/page                     | Materialized | Direct JSONB | Ordered relation |
| ------------------------------ | -----------: | -----------: | ---------------: |
| Popular/later                  |      535.865 |      382.147 |            0.186 |
| Sparse/first                   |        2.957 |        2.653 |            0.188 |
| Popular AND sparse/first       |      340.826 |        4.304 |            0.188 |
| Sparse AND popular/first       |      339.856 |        4.934 |            0.166 |
| Popular, English/first         |      557.613 |    10211.200 |           15.972 |
| Popular, English/later         |      475.661 |      348.923 |          238.498 |
| Popular, absent language/first |      386.841 |     9962.940 |          427.014 |
| Popular, absent language/later |      326.327 |      319.516 |          329.897 |

For the zero-matching-language first page, the ordered relation regressed from
the materialized query's 386.841 ms to 427.014 ms
(10.4%). In its third warm plan, the ordered query scanned all 200,000
popular-tag memberships, probed posts for 959 actors, and recorded 349,356
shared-buffer hits and 41,618 reads. The normal signed Korean first page
instead read 40 candidate memberships and recorded 295 shared-buffer hits with
no reads. Both used `idx_post_hashtag_tag_published`; the high-rejection case
also used the actor/post scan. Candidate work remains population-dependent when
other filters reject most or all posts.

The guest Korean ordered plan used parallel `Gather Merge`, so worker startup
contributed to its elapsed time despite few candidate rows. The direct JSONB
candidate was fast for guests but took 10.25 seconds for the signed Korean
first page. Removing materialization alone did not provide a reliable
replacement.

| Posts   | Memberships | Relation table MiB | Relation indexes MiB | Fixture seed seconds |
| ------- | ----------: | -----------------: | -------------------: | -------------------: |
| 100,000 |      57,734 |               3.79 |                 9.52 |                 8.83 |
| 400,000 |     230,841 |              15.05 |                37.83 |                38.80 |

Write probes explain a 1,000-row insert and 1,000-row unchanged-tags,
changed-tags, and changed-date updates with `ANALYZE`, `BUFFERS`, and `WAL`,
then repeat with only the hashtag synchronization triggers disabled. Each group
rolls back to a savepoint. Other application triggers and foreign keys remain
enabled. These single probes expose write costs rather than a stable throughput
estimate; physical page changes, cache state, and WAL full-page images can
affect the comparison. The JSON includes complete plans and trigger times.
Fixture seeding time includes all actors, edges, posts, mentions, and normal
insert triggers; it is not a standalone estimate of insert-trigger overhead.

At 400,000 posts, the single write probes recorded:

| Operation (1,000 rows) | Triggers enabled ms | Disabled ms | Hashtag trigger ms | Enabled plan WAL MiB | Disabled plan WAL MiB |
| ---------------------- | ------------------: | ----------: | -----------------: | -------------------: | --------------------: |
| Unchanged tags         |             147.480 |      65.993 |              0.000 |                40.79 |                  2.38 |
| Changed tags           |             170.972 |      74.430 |            100.807 |                 2.51 |                  2.43 |
| Changed date           |              92.483 |      64.850 |             16.713 |                 3.07 |                  2.42 |
| Insert                 |             159.294 |      64.284 |             70.013 |                14.45 |                  2.36 |

The unchanged-tags update did not invoke the hashtag trigger. WAL figures are
the counters reported for plan nodes, not a measurement of total cluster-WAL
growth or all trigger work. Full-page images and the fixed probe order prevent
interpreting the enabled/disabled WAL ratio as trigger overhead.

A separate rehearsal ran the actual unmodified migration through the project
runner on 400,000 existing posts. The successful retry took 1.553 seconds
including CLI startup; in the concurrency run, the resumed migration command
plus queued writer took 0.591 seconds. The derived relation contained 230,842
memberships after both test writers completed, with 15.05 MiB of table space
and 23.93 MiB of bulk-built indexes. The cluster WAL insertion delta was 43.04
MiB across the migration and queued writer; it is not migration-only WAL. The
difference from the benchmark's index size reflects bulk construction versus
incremental inserts.

Both a writer committing while the migration awaited its lock and a writer
queued behind the acquired lock left consistent memberships. A separate 100 ms
connection-URL `statement_timeout` caused the migration to abort with its
table, functions, triggers, and migration receipt absent. Retrying with URL
`statement_timeout=0` succeeded through the actual runner despite `PGOPTIONS`
specifying 1 ms. Statistics existed for all three derived columns after
migration. These local timings do not estimate production lock duration:
production deployment still needs a staging rehearsal with representative data
and active transactions.
