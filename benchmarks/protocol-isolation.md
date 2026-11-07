Protocol HTTP isolation fixture
===============================

The focused fixture passed on 2026-11-07 with the current `web-next` build.
It exercised separate interactive API, protocol HTTP, federation worker, and
SSR processes against the test PostgreSQL database. The protocol process was
then stopped while authenticated GraphQL and `/feed` requests continued to
succeed. This is local acceptance evidence for the resource boundary, not a
production SLO.

Run the core fixture with:

~~~~ bash
godotenv -f .env.test -o node --import temporal-polyfill/global \
  --test test/protocol-isolation.test.ts
~~~~

To include the actual SSR application, build the current source first, then run:

~~~~ bash
mise run build:web-next
PROTOCOL_ISOLATION_SSR=1 godotenv -f .env.test -o \
  node --import temporal-polyfill/global --test test/protocol-isolation.test.ts
~~~~

Run the timing fixture without simultaneous builds or other load generators.
It binds ephemeral loopback ports and does not use the development server on
port 5173. The test holds the existing exclusive fixture lock, commits one
uniquely named account and five posts, creates unique queue/KV tables, and
removes them after its child processes close. It never starts the production
worker or reads another queue. The PostgreSQL adapter is resolved through the
runtime package's declared public dependency, matching production's installed
version without adding a root dependency.

The interactive process uses the production Node HTTP adapter, API handler,
Yoga server, GraphQL schema, session validation, and snapshot transactions.
Each measured GraphQL request authenticates with a real session, reads the
viewer and actor, and fetches a five-post personal timeline with content and
author fields. The response must contain the expected username and five edges.
The optional SSR process runs *web-next/.output/server/index.mjs* with
`API_URL` pointing at that API. Each `/feed` request carries the session cookie;
the response must contain the rendered `<p>Isolation fixture post 0</p>` HTML,
not merely return a successful status.

The protocol process uses the production admission controller, API handler,
Node adapter, database resource factory, strict SQL wrapper, and document
loader factories. Its small Fedify builder returns valid `Note` objects.
Controlled dispatcher variants run PostgreSQL `pg_sleep(1)`, delay a document
cache read for one second while ignoring cancellation, or occupy the protocol
event loop synchronously for 600 milliseconds. This isolates resource
ownership from application dispatcher complexity. Cached signer documents
avoid external network dependencies while preserving actual RSA signature
verification for the inbox test.

The fixture uses two protocol HTTP slots, two PostgreSQL connections per role,
32 SQL permits, and eight loader permits. It shortens the HTTP deadline to
350 milliseconds and loader timeout to 200 milliseconds; server SQL timeout is
1,500 milliseconds. These settings deliberately leave unfinished dependencies
after a timeout response. Production defaults remain separate configuration.

The latency thresholds were selected before measurement: loaded p99 must be
at most 500 milliseconds and no more than 100 milliseconds above baseline,
with zero interactive errors and readiness failures. Cooperative overload
responses must arrive within 250 milliseconds. The CPU phase applies the
interactive latency thresholds only: JavaScript deadlines cannot preempt the
protocol process's blocked event loop.


Current-build SSR run
---------------------

The run completed in 31.26 seconds. Each phase included 80 authenticated
GraphQL requests and 40 SSR requests after 12 warmup requests of each kind.
Two GraphQL reads ran together; an SSR request followed each pair. The table
reports elapsed time through full response consumption, in milliseconds.

| Phase                    | GraphQL p95 | GraphQL p99 | SSR p95 | SSR p99 |
| ------------------------ | ----------: | ----------: | ------: | ------: |
| Baseline                 |       56.92 |       62.21 |   81.93 |   86.75 |
| Protocol SQL stalls      |       80.21 |       86.03 |  113.96 |  124.10 |
| Protocol loader stalls   |       52.34 |       54.84 |   80.00 |   82.76 |
| Protocol synchronous CPU |       51.76 |       74.24 |   75.70 |   84.25 |

All phases passed both latency thresholds. Interactive errors, readiness
failures, and restarts were zero. The fixture recorded 2,817 capacity
`503 Service Unavailable` responses, with a maximum elapsed time of
9.26 milliseconds. Sampled peaks were two admitted HTTP executions, two SQL
operations, and two loader calls, within their configured limits. The strict
SQL native-cancellation counter remained zero.

After the HTTP deadline response, both admitted slots and their two SQL or
loader permits remained occupied. They reached zero only when the actual
underlying work finished. The loader test deliberately ignored abort signals,
so this check covers retained ownership beyond the local timeout as well as
the overall HTTP deadline.

`pg_stat_activity` sampling observed two protocol connections, two interactive
connections, and three worker connections, including the worker's separate
`LISTEN` connection. Their simultaneous aggregate peak was seven. The
observer/exclusive-lock connections and unrelated database clients are outside
that workload count; production accounting must also reserve capacity for
replicas, rollout overlap, migrations, and other applications.

A real RSA-signed `Follow` submitted while admission was full received
`503 Service Unavailable`, did not increase admitted work, and left no queue
row or worker receipt. Retrying that same activity after draining received
`202 Accepted` and reached the separate Fedify queue worker. Neither HTTP
process executed the listener. Queue and deduplication storage used unique
PostgreSQL tables shared only by these fixture processes.

The protocol readiness endpoint stayed healthy during saturation. After
admission stopped it became unhealthy, and after the protocol child exited,
authenticated GraphQL and fully rendered SSR feed requests still succeeded.
All fixture children shut down without forced termination.


Remaining scope
---------------

This fixture does not exercise the full application's protocol dispatchers or
a reverse proxy. Signed/private application objects, discovery, association
files, uploads/media, and proxy routing need their corresponding focused and
smoke checks. The current-build SSR run verifies server output through direct
local upstreams; browser hydration, staging topology, host resource limits,
and production latency remain separate acceptance evidence.
