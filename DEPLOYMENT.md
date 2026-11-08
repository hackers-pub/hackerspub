Deployment
==========

This document describes how Hackers' Pub is deployed, how to cut over to a new
build, and how to roll one back.  For local development, read
[*CONTRIBUTING.md*](./CONTRIBUTING.md) instead.


Roles
-----

One container image serves four roles.  They are separate processes with
separate lifecycles, and the deployment definition chooses which role a
container runs and which probe watches it:

| Role                                      | Start command                  | Health check                      | Port |
| ----------------------------------------- | ------------------------------ | --------------------------------- | ---- |
| Interactive API (`HTTP_ROLE=interactive`) | `mise run prod:graphql`        | `mise run prod:hc:graphql`        | 8080 |
| Protocol HTTP                             | `mise run prod:protocol`       | `mise run prod:hc:protocol`       | 8081 |
| Worker                                    | `mise run prod:graphql-worker` | `mise run prod:hc:graphql-worker` | none |
| Web UI                                    | `mise run prod:web-next`       | `mise run prod:hc:web-next`       | 3000 |

The image declares `HEALTHCHECK NONE` precisely because the probes differ per
role; a deployment that omits them gets no health signal at all.

> [!IMPORTANT]
> The worker must run as its own process and must never sit behind a load
> balancer.  It serves no HTTP surface, and its probe reads the heartbeat file
> at `WORKER_HEALTH_FILE` (default */tmp/hackerspub-graphql-worker.health*)
> rather than a port.  Its scheduled jobs coordinate through PostgreSQL locks,
> leases, and idempotent claims, so additional replicas are safe, but each
> needs its own heartbeat path.

Both HTTP roles and the worker must share Redis through `KV_URL`. File KV is
accepted only in explicit combined development mode; split roles and production
require Redis. Neither HTTP process starts queue consumers.

`prod:graphql` defaults to `HTTP_ROLE=combined` for compatibility. Set
`HTTP_ROLE=interactive` when routing protocol traffic to the separate service.
`prod:protocol` forces the protocol role even if the environment selects another
role. `HTTP_HOST` defaults to `0.0.0.0`; `HTTP_PORT` defaults to 8080 for
interactive/combined and 8081 for protocol.


Web UI GraphQL deadlines
------------------------

The Web UI bounds Relay requests to `API_URL`, including response body reads.
These runtime settings apply to the web-next process:

| Variable                             | Default  | Scope                                                 |
| ------------------------------------ | -------- | ----------------------------------------------------- |
| `WEB_SSR_GRAPHQL_TIMEOUT_MS`         | `10000`  | One SSR GraphQL operation                             |
| `WEB_SSR_GRAPHQL_BUDGET_MS`          | `15000`  | Shared data-loading budget from page middleware entry |
| `WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS` | `180000` | One browser-initiated Relay RPC query or mutation     |

Each value must be an integer from `1` to `2147483647` milliseconds. Missing
values use the defaults; an invalid value, including an explicit empty string,
fails when its policy is first used. Interactive RPC calls read only the
interactive setting. The bundled *docker-compose.yml* substitutes defaults for
unset or empty variables before web-next reads them.

SSR operations use the smaller of their own limit and the page's remaining
budget. Sequential queries cannot reset that budget. There is no shared abort
controller between requests or operations: disconnecting a caller or disposing
a Relay request cancels only its upstream fetch. Deadline expiry surfaces in
Relay as a `TimeoutError`; deliberate cancellation is not sent to Sentry. SSR
operations and mutations are not retried automatically. Browser queries retain
their existing transient-network retry policy.

Interactive operations, including alt-text generation, use the separate longer
limit even when they are queries. These limits stop the Web UI's upstream HTTP
request and response consumption. They do not preempt synchronous JSON parsing,
bound all page rendering, or guarantee that downstream API/AI work has stopped.

After `mise run build:web-next`, run `mise run smoke:ssr-graphql` to exercise
the built server against a local fake GraphQL endpoint. It uses isolated ports
and needs no database or running API. The checks cover stalled headers/bodies,
disconnects, Relay disposal, shared page budgets, concurrent requests, and the
longer interactive policy.


Protocol HTTP isolation
-----------------------

The split deployment gives protocol HTTP its own event loop, database pool,
admission limits, and container resource limits. The interactive process still
creates federation contexts and produces queue work. It serves GraphQL,
uploads/media, and the exact application-association files; it rejects protocol
paths. The protocol process serves ActivityPub, WebFinger, and NodeInfo, and
constructs no GraphQL Yoga server or anonymous GraphQL admission client.
Combined mode retains the shared process behavior and does not provide these
protocol isolation bounds. Protocol settings are ignored by other HTTP roles.

The Compose example runs the interactive API on 8080 and protocol HTTP on 8081.
Both Caddy examples use an explicit ordered route: exact
`/.well-known/assetlinks.json` and
`/.well-known/apple-app-site-association` go to the API first, then
`/.well-known/*`, `/ap/*`, and `/nodeinfo/*` go to protocol. `/graphql` and
its subtree, exact `/medium-uploads` and its subtree, and `/media/*` go to
the API; everything else goes to web-next. Preserve this order when adapting
another proxy. `/health` is internal and the public gateway rejects it.

Protocol readiness is `GET /health`, returning
`{"ready":true,"role":"protocol"}` only after resources and the durable inbox
queue are initialized. A full execution budget stays ready: excess traffic
receives retryable responses rather than causing health-driven restarts.
Interactive readiness continues to execute `{__typename}` through GraphQL.
Web-next and the gateway depend only on interactive readiness, so a stopped or
saturated protocol service does not prevent them from starting or becoming
ready. The worker remains background only and uses its heartbeat file.

Interactive readiness also becomes unhealthy when its anonymous-read admission
store reports a permanent failure, even if the cheap GraphQL schema probe still
succeeds. A full admission budget alone remains healthy. HTTP health probes use
`HTTP_HOST`, mapping wildcard binds to the matching loopback address.

### Limits and connection accounting

These defaults apply per protocol process and are validated before listening:

| Variable                             | Default    | Bound                                                                                       |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| `PROTOCOL_REQUEST_LIMIT`             | `4`        | Admitted HTTP executions, including body and dependency cleanup; no queue                   |
| `PROTOCOL_REQUEST_TIMEOUT_MS`        | `15000`    | Absolute HTTP deadline, including drain                                                     |
| `PROTOCOL_REQUEST_BODY_LIMIT_BYTES`  | `16777216` | Signed request bytes, checked before forwarding                                             |
| `PROTOCOL_RESPONSE_BODY_LIMIT_BYTES` | `16777216` | Materialized response bytes                                                                 |
| `DATABASE_MAX_CONNECTIONS`           | `4`        | Protocol PostgreSQL pool; interactive/worker default to `20`                                |
| `PROTOCOL_SQL_LIMIT`                 | `32`       | Consumed SQL, transaction, and notify operations, including queued work                     |
| `PROTOCOL_SQL_TIMEOUT_MS`            | `5000`     | Server statement, idle-transaction, and connect budgets; lock timeout is at most one second |
| `PROTOCOL_LOADER_LIMIT`              | `8`        | Concurrent document, context, and authenticated loads, including KV access                  |
| `PROTOCOL_LOADER_TIMEOUT_MS`         | `5000`     | Per-load cancellation timer; actual completion remains owned                                |

Admission happens in the protocol service before its own body reads and
trusted-forwarding processing. The gateway has already accepted the request
and may buffer or forward body bytes before rejection. Account for gateway
connections, buffering, and resource limits separately. Excess work
returns [`503 Service Unavailable`]
with `Retry-After: 1` and `Cache-Control: no-store`. The absolute deadline and
server SQL timeouts return
[`504 Gateway Timeout`].
A successful response transmission shares the original request deadline. An
error reply starting after that deadline has at most one second to flush before
the socket is closed. Admission remains occupied until both owned dependencies
and the Node.js response transmission have finished or closed; a stalled writer
cannot release its slot while retaining response buffers.

A local loader timeout cancels that load without aborting sibling work. A fully
completed optional `GET` or `HEAD` fallback below 400 is preserved. Other
methods and failed responses become `504 Gateway Timeout` after dependency
interruption, including a later successful inbox-verification fallback. This
preserves retryability when verification was interrupted. Interrupted
public-key lookups cannot persist key-cache entries that would poison a later
signed retry. Genuine remote key failures retain ordinary negative caching.

Protocol SQL never sends native PostgreSQL `CancelRequest` messages.
Cancellation prevents new application work; consumed queries and transaction
completion keep their permits until actual settlement under server budgets. A
queued write or commit can finish after the HTTP timeout or disconnect. The
HTTP boundary provides no rollback guarantee, and an inbox enqueue whose
acknowledgement was lost has an unknown outcome. Preserve existing
at-least-once retry and deduplication behavior. Statement timeout does not
bound driver queue wait, a whole transaction, or a broken network. A dependency
that ignores cancellation retains its HTTP/SQL/loader permits and can delay
shutdown.

Protocol federation Redis operations use `PROTOCOL_LOADER_TIMEOUT_MS` to bound
each command. A stalled operation closes its connection and waits for actual
command/socket settlement before releasing ownership. Uncertain writes are not
replayed. Later new operations may open a fresh connection after the failed
connection ends; interactive and worker Redis behavior is unchanged.

Protocol startup rejects the PostgreSQL URL `options` parameter and overwrites
conflicting timeout parameters with enforced budgets, regardless of case. Do
not use this service for migrations requiring longer statements.

Count pool limits across all replicas, including old and new replicas during a
rollout. For example, one interactive API, one protocol service, and one worker
allow 20 + 4 + 20 pooled PostgreSQL connections, plus one worker `LISTEN`
connection. Reserve additional capacity for ordinary API cancellation sockets,
whose peak must be measured, migrations, administration, and other applications.
Protocol contributes zero cancellation-control sockets. Raising the HTTP or SQL
limit does not raise the protocol pool, and raising the pool affects the
aggregate database budget.

The Compose example caps protocol CPU at one core, memory at 512 MiB, and PIDs
at 128. Override `PROTOCOL_CPUS`, `PROTOCOL_MEMORY_LIMIT`, and
`PROTOCOL_PIDS_LIMIT` for the host after measurement. Four simultaneous maximum
request/response buffers alone can occupy 128 MiB; JSON parsing, cloned data,
SQL, and the runtime require more. Resource limits protect the interactive
process from protocol CPU/memory pressure but do not promise a timely protocol
response while its own event loop is blocked.

`PROTOCOL_STOP_GRACE_PERIOD` defaults to 25 seconds in Compose. Size it from
measured drain times for owned SQL, transactions, and loader cleanup, including
queued work. The HTTP deadline and its one-second connection-drain allowance
do not bound that work. Shutdown stops admission, drains HTTP, aborts remaining
scopes, and waits for actual owned work before closing dependencies, but Compose
can send `SIGKILL` when its grace period expires, even with the default setting.
Treat forced termination as a crash: an unacknowledged enqueue or commit has an
unknown outcome and may already have succeeded. Preserve retries and existing
deduplication, and allow for duplicate processing under at-least-once delivery.

[`503 Service Unavailable`]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/503
[`504 Gateway Timeout`]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/504

### Cutover, rollback, and validation

Start a compatible worker and the protocol service before switching protocol
proxy routes. While the API remains combined, apply the ordered split routing
above; then switch the API to `HTTP_ROLE=interactive`. Check both role probes
and public discovery/associations; stop protocol briefly and verify the API and
web UI remain ready. Do not make web/gateway readiness depend on protocol or
start queue consumers in HTTP processes.

To return to combined mode, start `prod:graphql` with `HTTP_ROLE=combined`,
confirm its GraphQL and discovery responses, then route the protocol path
families back to that API before stopping the separate protocol service.
Restore the former container/pool limits consciously: combined mode shares
resources again. Keep the standalone worker running; no HTTP consumer is needed
for rollback.

`mise run smoke:standalone` starts both HTTP roles, a worker, and a built web
UI, checks discovery, exact associations, opposite-role rejections, and
interactive readiness after stopping protocol. It defaults to ports 18080,
18081, and 13000; set `STANDALONE_SMOKE_API_PORT`,
`STANDALONE_SMOKE_PROTOCOL_PORT`, and `STANDALONE_SMOKE_WEB_PORT` when needed.
It refuses occupied ports and stops only its own children.
`STANDALONE_SMOKE_KV_URL` selects the test Redis database. Use a dedicated test
database and Redis instance because the worker runs normal queue consumers and
schedules.

Before production cutover, rehearse valid signed/private reads, durable inbox
acceptance and worker consumption, disconnects, stalled dependencies, and proxy
routing on staging. Measure baseline/loaded interactive errors and p95/p99
latency, active HTTP/SQL/loader counts, and database connections under protocol
load and a separate CPU-pressure phase. Local fixtures do not establish a
production SLO or identify the cause of issue #443. Staging and manual
sign-in/authenticated GraphQL/SSR checks remain required.


Images
------

CI builds and pushes on every merge to `main`:

 -  `ghcr.io/hackers-pub/hackerspub:git-<sha>` — the immutable release
    identifier.  **Deploy this, not `latest`,** so a rollback has something
    exact to return to.
 -  `ghcr.io/hackers-pub/hackerspub:latest` — a moving pointer to the newest
    build.
 -  `ghcr.io/hackers-pub/hackerspub:git-<sha>-amd64` and `-arm64` — the
    per-architecture images the manifest above fuses.

The build stamps `+<sha>` onto the version in *federation/package.json*,
*graphql/package.json*, *models/package.json*, and *web-next/package.json*, so
the running commit is visible through NodeInfo, the ActivityPub software
version, the outgoing user agent, and the Sentry release.


Cutover
-------

1.  Confirm CI is green for the commit you intend to deploy, and that
    `ghcr.io/hackers-pub/hackerspub:git-<sha>` exists.

2.  **Record the currently deployed image reference.**  Without it there is
    nothing to roll back to:

    ~~~~ sh
    docker inspect --format '{{.Config.Image}}' <running-container>
    ~~~~

    If that reports a moving tag such as `latest`, resolve the commit it is
    actually running and rebuild the immutable reference by hand:

    ~~~~ sh
    docker inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      <running-container>
    ~~~~

    The label holds the bare commit SHA, so the tag to record is
    `ghcr.io/hackers-pub/hackerspub:git-<sha>`.

3.  Pull the new image on the host.

4.  A release that includes [#390] needs the `post.url` hash index before its
    migration runs.  From a shell with the production `DATABASE_URL`, inspect
    any index left by an earlier attempt:

    ~~~~ sh
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
    SELECT i.indisready, i.indisvalid, pg_get_indexdef(i.indexrelid)
    FROM pg_index AS i
    JOIN pg_class AS c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'post'::regclass
      AND c.relname = 'idx_post_url_hash';
    SQL
    ~~~~

    An existing index is usable only when both flags are `t` and the definition
    is a hash index on `post.url` with the `url IS NOT NULL` predicate.  If the
    query returns no rows, create it in its own `psql` invocation:

    ~~~~ sh
    PGOPTIONS='-c statement_timeout=0' \
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
    CREATE INDEX CONCURRENTLY idx_post_url_hash
      ON post USING hash (url) WHERE url IS NOT NULL;
    SQL
    ~~~~

    Do not wrap this command in a transaction.  If the inspection query finds
    an index whose flags or definition do not match, remove it and repeat the
    concurrent build:

    ~~~~ sh
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
    DROP INDEX CONCURRENTLY idx_post_url_hash;
    SQL
    ~~~~

    Run the inspection query again after the build.  Do not continue until it
    reports the expected definition with both flags set to `t`.

    A release adding the latest authored-link lookup also needs
    `idx_post_link_url_latest` before its migration. Inspect any existing index:

    ~~~~ sh
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
    SELECT i.indisready, i.indisvalid, pg_get_indexdef(i.indexrelid)
    FROM pg_index AS i
    JOIN pg_class AS c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'post'::regclass
      AND c.relname = 'idx_post_link_url_latest';
    SQL
    ~~~~

    Both flags must be `t`, and the definition must be a B-tree on
    `(md5(link_url), updated DESC)` with the `link_url IS NOT NULL` predicate.
    If no index exists, build it outside a transaction:

    ~~~~ sh
    PGOPTIONS='-c statement_timeout=0' \
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
    CREATE INDEX CONCURRENTLY idx_post_link_url_latest
      ON post (md5(link_url), updated DESC) WHERE link_url IS NOT NULL;
    SQL
    ~~~~

    If an existing index has invalid flags or a different definition, remove it
    with `DROP INDEX CONCURRENTLY idx_post_link_url_latest` and repeat the
    build in separate invocations. Inspect the index again before continuing.
    Keep `idx_post_link_url_hash` through the rollback window: the previous
    release's lookup needs it because it cannot use the new expression index.

5.  A release that switches email delivery from Mailgun to Maileroo needs a
    verified Maileroo sending domain before it starts.  Give the API and worker
    `MAILEROO_KEY` (the domain's sending key) and set `EMAIL_FROM` to an
    address on that domain; `MAILGUN_FROM` is no longer read.  The new image
    refuses to start in production without `MAILEROO_KEY`.  In development,
    test, and build modes without this key, emails are logged with their
    subject and body instead of sent, so verification codes and sign-in links
    can be read in the local console.  These messages bypass `LOG_FILE` and
    Sentry; keep the development console private.  CI uses `MockTransport`.
    Leave the `MAILGUN_*` variables in place until the rollback window closes,
    because the previous image still needs them.

6.  Run database migrations once, from the new image, before starting any
    service on it:

    ~~~~ sh
    mise run migrate
    ~~~~

    Installations upgraded from the removed Fresh application also need
    `mise run migrate:media` once; it is safe to repeat and never overwrites.

    Installations with articles published before post content variants existed
    also need `mise run migrate:variants` once, after the API is running on the
    new image.  It rebuilds each local article's language variants from its
    published versions, federates nothing, and is safe to repeat.

7.  Restart the roles in this order, waiting for each probe to pass before
    continuing: **worker → protocol and API → web UI.**  The worker first
    so queued federation processing can resume. Inbound updates and outbound
    delivery wait while no worker is running; a prolonged restart delays them
    for users. The API precedes the web UI because the web UI proxies to it.

8.  Run the post-deploy checks below.

The API and worker shut down gracefully on `SIGTERM`: the API stops accepting
connections and drains in-flight requests, and the worker stops taking new
scheduled ticks, lets active jobs finish, and asks Fedify's queue listener to
stop.  Give them time to exit rather than killing them, or in-flight federation
work may be retried, and can be duplicated when a delivery completed before its
acknowledgement was recorded.  See [*FEDERATION.md*](./FEDERATION.md) for the
delivery guarantees this preserves.

[#390]: https://github.com/hackers-pub/hackerspub/issues/390


Post-deploy checks
------------------

Each role's own probe:

~~~~ sh
mise run prod:hc:graphql
mise run prod:hc:protocol
mise run prod:hc:graphql-worker
mise run prod:hc:web-next
~~~~

Then, against the public origin, the surfaces *scripts/smoke-standalone.ts*
already covers in CI.  These are the cheap ones, and a failure here means the
deployment is broken outright:

 -  `POST /graphql` with `{__typename}` returns
    `{"data":{"__typename":"Query"}}` and no `errors`.
 -  `/.well-known/nodeinfo` returns `application/jrd+json`.
 -  `/.well-known/assetlinks.json` and
    `/.well-known/apple-app-site-association` return `application/json`.
 -  `/search` renders.

Nothing automated covers the rest, so walk through it by hand:

 -  The NodeInfo document reports the version you just deployed.
 -  A profile and a post render, and their ActivityPub representations resolve.
 -  Sign-in by email and by passkey both work.
 -  A media upload succeeds and the uploaded file is served back.
 -  Sentry shows the new release and no new error class.
 -  A remote follow and an outbound delivery both complete.  The worker is the
    only process that delivers, so a worker that failed to start is invisible
    to every HTTP check above.


Rollback
--------

Roll back the web UI to the previously recorded image first. Before downgrading
the API to a release that predates protocol isolation, switch the current API
to `HTTP_ROLE=combined` and route federation and discovery traffic back to it,
following [Cutover, rollback, and validation]. Verify public discovery and
interactive routes, then stop and remove the separate protocol role. Do not
redeploy that role with the older image: it has no `prod:protocol` task. Finish
by downgrading the API and worker, then rerun the post-deploy checks.

The web UI goes first because the newer composer queries fields such
as `Account.viewerCanActAs` and `ArticleDraft.revision` that the older API does
not expose, while the older web UI keeps working against the newer API.

The `idx_post_url_hash` index added for [#390] is additive and can remain in
place during an image rollback.  If its concurrent build fails before cutover,
drop the invalid index with the command above and retry it; do not start the
new image while the index is invalid.

An image from before the switch to Maileroo sends email through Mailgun, so
rolling back across that switch needs the `MAILGUN_*` variables (and
`MAILGUN_FROM` or `EMAIL_FROM`) that the older image reads.

> [!CAUTION]
> Rollback is image-level only.  There is no second runtime to fall back to,
> because [#351] removed Deno: every `dev:*` and `prod:*` task runs Node.js.
>
> Database migrations are **not** reversed by rolling the image back.  If the
> deployment included a migration that the older image cannot tolerate, restore
> the database from backup instead, and treat the rollback as a data-loss
> window that has to be planned rather than improvised.

Rehearse this before you need it: deploy the current tag, then redeploy the
previous one, and confirm the checks pass at both ends.

[Cutover, rollback, and validation]: #cutover-rollback-and-validation
[#351]: https://github.com/hackers-pub/hackerspub/issues/351

### Multiple email addresses

The migration for multiple email addresses selects the earliest verified
address (ordered by creation time, then address) as each personal account's
primary notification address.  Notification digests subsequently go to that
address.  Existing unverified addresses remain private and cannot sign in.
Owners can verify or remove them in Settings → Account.

Before applying this migration, check for addresses that differ only in case:

~~~~ sql
SELECT lower(email), array_agg(account_id), count(*)
FROM account_email
GROUP BY lower(email)
HAVING count(*) > 1;
~~~~

The new unique index rejects such collisions rather than merging credentials.
If the query returns rows, confirm ownership and reconcile them manually before
retrying the migration.  Do not transfer an address between accounts without
establishing ownership.  Retain the verified address when consolidating rows
belonging to the same account.

Also check for personal accounts that have no usable sign-in credential:

~~~~ sql
SELECT a.id, a.username
FROM account a
WHERE a.kind = 'personal'
  AND NOT EXISTS (SELECT 1 FROM account_email e
                  WHERE e.account_id = a.id AND e.verified IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM passkey p WHERE p.account_id = a.id);
~~~~

Reconcile these accounts before deploying: email sign-in now requires a
verified address.  Verify ownership through an established trusted channel; do
not mark an address verified solely to make the query return no rows. Accounts
with no remaining credentials cannot use Settings to repair their access.  This
feature does not provide a standard recovery procedure.

Gravatar now uses the primary verified address only, so adding a secondary
address does not publish its hash or change the avatar.  Legacy accounts with
several addresses may see a different Gravatar after the migration; cached
federation avatars are refreshed on the next profile synchronization.  Choosing
a different primary address synchronizes the avatar immediately when no
uploaded avatar exists.


Application tasks
-----------------

The API is a producer.  Both roles register the same versioned tasks before
building Fedify; only the standalone worker starts consumers.  Tasks use a
separate `application.task` queue in PostgreSQL's logged `outbox_event` table,
with `taskQueueResolution: "strict"`.  Inbox, fanout, and delivery consumers
cannot claim these rows.  Redis remains required for the worker's shared KV;
task correctness does not depend on Redis deduplication markers or CAS.

Model code dispatches through `ApplicationContext.enqueueTask()`.  Put the
state change and dispatch inside `withTransaction()` and await dispatch there.
The Fedify envelope is inserted using that same database transaction, before
commit.  Rollback removes both state and intent; enqueue failure propagates and
rolls back the transaction.  After commit there is no separate enqueue step to
lose: a worker can poll the intent even if the API crashes immediately. Do not
move this dispatch into the in-memory after-commit callbacks or catch an
enqueue error and continue the transaction.

Payloads are plain JSON identifiers, revisions, and job tokens, validated by an
idempotent Standard Schema on enqueue and dequeue.  Avoid credentials,
vocabulary objects, and other values whose encoding could perform network I/O
inside a transaction.  The application descriptor resolves to the exact Fedify
handle registered on the shared builder.  The handler receives
`(ApplicationContext, payload, { signal, attempt })`; it must await execution,
result persistence, and any follow-up dispatch, and pass `signal` to
cancellable I/O.

Delivery is **at least once**.  Every new enqueue has a new transport ID; the
DB unique index suppresses replay of that transport ID, not independent
requests for the same job.  Each workload must enforce DB-backed claims,
revision checks, and side-effect guards.  Enqueue deduplication is not
execution idempotency.  The `application.probe.v1` task demonstrates this with
an `application_task_receipt` UUID primary key and an idempotent insert.
Receipts are retained independently of the queue's completed-message retention.

Ordering keys are optional and are namespaced separately from ActivityPub
keys.  The advisory lock taken during enqueue lasts until the caller's
transaction commits.  Acquire multiple keys in a consistent order: otherwise
PostgreSQL can abort a deadlock victim, rolling back its state and intents. A
delayed retry blocks later work with the same key; choose keys only when that
FIFO behavior is required.

### Retries, timeouts, and shutdown

Two queue-owned claim loops execute tasks concurrently, each awaiting its real
handler before acknowledging or claiming another row.  Do not wrap this queue
in Fedify's `ParallelMessageQueue`: that wrapper returns to the backend before
the real handler finishes.

The task backend declares `nativeRetrial: true`, so Fedify rethrows handler
failures and the DB queue owns the retry budget.  The default is three
attempts, with 5-second and 10-second delays before retries.  A hard worker
termination consumes its claimed attempt; repeated terminations cannot cause
unlimited execution.  Per-task Fedify `retryPolicy` does not run on this
backend.  Future workloads needing another budget must configure a dedicated
task queue with `maximumProcessingAttempts` rather than layering a second retry
mechanism.

Each task has a 30-minute deadline, a 3-minute lease, and 60-second renewal.
Custom renewal intervals must be shorter than half the lease duration. A
deadline aborts the execution signal with `ApplicationTaskTimeoutError` and
counts as a failure.  Definitive lease loss cancels execution; transient
renewal errors are logged and tolerated until the last successful renewal is
within one heartbeat interval of expiry.  Old lease tokens cannot complete,
retry, or fail a row reclaimed by another worker.  This fence protects queue
state; workload guards must also protect application writes and external side
effects during a network partition.

SIGINT/SIGTERM stops new claims and cancels running handlers.  The worker waits
for the **actual handlers and outstanding lease writes** before closing
resources.  Drained interrupted rows return to `pending` without spending a
failure attempt, including an interruption on the last allowed attempt. If a
deadline or lease failure already cancelled execution before shutdown, that
failure still consumes its attempt. `last_error.details.interruptions` and
structured release logs expose repeated interruption/starvation.  A handler
that returns after cancellation is also released rather than acknowledged, so
an effect committed during drain may execute again.  Make the entire operation
idempotent.

A handler ignoring cancellation can delay shutdown indefinitely.  Its lease
continues renewing while it drains, avoiding overlap with a still-live worker.
Timeout logs identify the event immediately, and later renewal ticks warn that
it is still draining.  The worker health file proves process liveness, not task
progress.  Give the supervisor a stop grace slightly longer than 30 minutes for
long LLM jobs, or explicitly accept restart when choosing a shorter grace.  If
draining never ends, terminate the worker with SIGKILL and restart it; recovery
takes up to three minutes after its last successful renewal.  Plan deploy
cadence so long tasks can finish, or pause producers and drain before
deployment.

### Observability and recovery

Fedify emits `fedify.task` spans with `fedify.task.name` and the zero-based
`fedify.task.attempt`, plus the `fedify.queue.task.*` metrics.  The backend
presents its DB attempt count to Fedify without rewriting the stored payload.
On this native-retry backend a retryable handler error records a failed span on
each attempt; a queue retry log and `processing_attempts` distinguish those
from terminal dead letters.  Unknown names and codec/schema failures still emit
Fedify's `unknown_task`, `deserialization`, or `validation` failure reason. The
registered-handler entry guard retains those dropped messages as `dead` with
`TaskDispatchRejectedError`, rather than clearing them as completed.

Use the operator CLI (with the same environment as the API/worker):

~~~~ bash
mise run tasks:application -- enqueue
mise run tasks:application -- receipt JOB_UUID
mise run tasks:application -- dead
mise run tasks:application -- replay EVENT_UUID
~~~~

`enqueue` uses the API's resource/context path and returns a probe job UUID;
`receipt` returns `null` until the worker persists completion.  `dead` lists
IDs, task names, attempts, and errors without decoding opaque payloads.
`replay` accepts only a dead `application.task` event with a retained payload
and resets its DB attempt count.  Restore compatible registrations/schemas
before replaying dropped messages; replay alone cannot repair schema drift.

Dead tasks are excluded from automatic outbox pruning.  Inspect backlog and
stale leases directly when diagnosing a stuck worker:

~~~~ sql
SELECT id, status, payload->>'taskName' AS task_name,
       processing_attempts, available, leased, last_error
FROM outbox_event
WHERE event_type = 'application.task'
ORDER BY created;
~~~~

If a dead task is deliberately abandoned, record the reason in the operational
incident and remove only its exact ID:

~~~~ sql
DELETE FROM outbox_event
WHERE id = 'EVENT_UUID'::uuid
  AND event_type = 'application.task'
  AND status = 'dead';
~~~~

### Rollout and rollback compatibility

Apply the additive receipt-table migration first.  Upgrade the **entire worker
fleet before API producers**, retaining registrations and schemas for all
queued payload versions.  A pre-infrastructure worker ignores task rows,
leaving them pending.  An older task-capable worker can consume a new name or
schema and drop it; the adapter preserves that row as dead for recovery, but
operators must restore compatibility and replay it.

For rollback, stop/revert the newer producers first and retain compatible
workers until their pending/processing tasks drain.  Do not rename/remove a
task or narrow its schema while pending, processing, or recoverable dead rows
still require it.  The receipt migration can remain in place.  Review retained
dead rows before retiring a registration.  Restore a compatible worker and
replay affected IDs after a mistaken incompatible deployment.

The infrastructure regression suite runs a separate producer and task-only
worker against the test PostgreSQL backend, including SIGKILL both before
persistence and after persistence but before acknowledgment.  It deliberately
runs no cron, email, ActivityPub delivery, or LLM calls. Separate regression
suites cover the migrated translation, summary, and scheduled workloads; their
execution and recovery behavior is documented in the following sections.

See [Fedify's task documentation] for the serialization, retry, and telemetry
contracts.

[Fedify's task documentation]: https://fedify.dev/manual/tasks

### Scheduled worker tasks

Croner remains the UTC trigger. Six schedules persist `scheduled.worker.v1`
tasks, containing an allowlisted job name and the original minute tick as an
ISO timestamp. Enqueueing records intent, not completed execution. The worker
awaits the operation and its persistence before acknowledging the task.

| Job                                      | UTC schedule  | Execution and duplicate protection                                                                                                                                                     |
| ---------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| News score recomputation                 | `*/5 * * * *` | Task; retains the transaction-scoped advisory lock and uses tick minus one hour for the active window. Repeated recomputation is safe.                                                 |
| News rescore drain and suspension expiry | `* * * * *`   | Direct execution retained: the existing per-actor DB queue already persists work and uses renewable leases with `FOR UPDATE SKIP LOCKED`. Another task queue adds no recovery benefit. |
| Ended-poll notifications                 | `* * * * *`   | Task; uses the tick as the ended-poll cutoff. Poll claims and deduplicated notifications commit together.                                                                              |
| Weekly notification digest               | `0 0 * * 1`   | Task; original tick selects the weekly period. Delivery claims and independently saved recipient progress guard retries.                                                               |
| Daily notification digest                | `5 0 * * *`   | Task; original tick selects the daily period and Monday suppression for weekly subscribers.                                                                                            |
| Transactional outbox pruning             | `30 3 * * *`  | Task; cutoffs remain tick minus one day for completed events and 30 days for failed delivery events. Dead application tasks remain excluded.                                           |
| Article-view deduplication pruning       | `45 3 * * *`  | Task; deletes rows whose expiry is at or before the original tick. Repeated deletion is safe.                                                                                          |

`scheduled_worker_dispatch` stores one latest-dispatched watermark per migrated
job. The watermark and outbox task intent commit in the same transaction.
Duplicate replica ticks and older callbacks do not enqueue again; an enqueue
failure rolls both back and is logged as a scheduler failure. Each job has an
ordering key spanning its intervals, so queued execution and retry do not
overlap under a live lease. Workload DB locks/claims remain necessary during
lease loss and duplicate delivery.

There is **no startup backfill**. A tick never accepted during downtime or a
dispatch failure is skipped; the next normal tick runs. Polls, cleanup and the
rescore drain cover older backlog on their next run; news retains its one-hour
active window. A missed weekly digest waits for the next week. Accepted task
intents survive downtime and retain their original cutoffs on retry/restart.
Synchronize replica clocks: a future watermark after clock skew or a backward
clock adjustment can suppress dispatch until wall time catches up. Scheduling
shares the existing FIFO task queue with translations/summaries; LLM backlog
can delay ticks, and no scheduling latency guarantee or task priority is added.

Digest periods and notification creation cutoffs come from the original tick,
including for replay on a later day. Unread state, opt-in, primary-address
selection and verified recipients are read live. Reclaim refreshes the unread
count, excluding notifications created after the tick. A frequency-specific
advisory transaction lock serializes senders, including an aborted handler
still draining its in-flight email. Acquisition polls every 250 ms, supports
cancellation, and fails after three minutes of contention. The normal
three-attempt task budget applies to lock waits and delivery failures,
including provider quota errors. Exhaustion is visible and replayable.

The guard reserves one DB connection (with its local idle transaction timeout
disabled); recipient progress uses the root DB and commits independently on
another connection. Guard rollback cannot erase sent-recipient records. The
worker checks guard liveness and cancellation before claims/sends, awaits an
in-flight send without cancelling it, saves accepted recipients, then observes
cancellation. A retry reclaims unfinished delivery claims immediately under the
guard and skips recipients already saved. If mail succeeds but both progress
and failure-record writes fail, or the process is killed between send and save,
replay may send duplicates. Guard loss during a send has the same ambiguity.
This is at-least-once email delivery, not exactly once.

On shutdown, stop future cron ticks and drain accepted dispatch writes and the
retained rescore drain. Queue shutdown separately waits for actual handlers and
their recipient progress before closing transports/DB resources. Task payloads
contain no credentials; only the worker supplies the execution capability with
runtime email resources. A missing capability fails visibly and eventually
leaves a dead task.

Apply the dispatch-watermark migration before starting new workers. Stop and
drain **all legacy worker schedules and digest sends** before enabling the new
workers: legacy senders do not acquire the digest guard. Avoid a cutover that
straddles the weekly/daily UTC digest ticks because there is no catch-up. Both
roles register `scheduled.worker.v1`; retain this registration and payload
schema on rollback until pending, processing and recoverable dead tasks drain.
An older worker can consume and dead-letter an unknown scheduled task.

Inspect dead scheduled tasks using the common operator CLI and outbox queries.
Later poll/pruning ticks usually cover a failed tick's backlog; a later news
tick recomputes its active window. Decide whether to replay or deliberately
abandon these old ticks using the documented dead-letter procedure. Digest
replay always targets its original period and preserves known recipients. Do
not mistake a dispatch watermark or a later tick for evidence that the failed
task completed.

### Article translation tasks

Translation requests and source edits persist `article.translation.v1` intents
atomically with their placeholders. The API returns without calling the LLM;
run the standalone worker to complete them. Payloads contain the source UUID,
stored language key, and `translationJobToken`. The worker loads current
content, author context, and translation eligibility, then awaits translation,
reader-variant materialization, and transactional federation delivery. Human
publication, disabled LLM translation, and newer source revisions fence off
older results. Censored articles retain reader variants without federation.

Tasks for one source/language use an ordering key. Duplicate deliveries cannot
publish conflicting results, but an interrupted call or expired lease can
repeat LLM work. Retries use the same token and re-read the current claim,
including after worker termination. A killed worker's event becomes reclaimable
after the queue lease expires (normally three minutes), consuming one of the
three attempts. The existing 30-minute reader reclaim window also remains: a
reader may supersede a slow active or retrying job with a new token. This can
waste an LLM call; the token and claim checks discard its obsolete result.

Ordinary LLM or persistence failures retain the placeholder and age its claim,
so either a queued retry or a new reader request can recover it immediately.
Cancellation retains the claim for worker recovery. Exhausted tasks retain
their payload in the dead-letter queue. Use the `dead` and `replay` commands
above; replay is useful only while the placeholder still has the payload's
token. A completed, deleted, or superseded job is a no-op. If the original
changes without rotating an unfinished job's token (for example, a title-only
edit), the worker atomically refreshes its placeholder and queues a replacement
instead of leaving it without queued work. Existing placeholders from before
this migration become queued work on their next stale reader request.

A successful translation persists a summary intent and a `summaryStarted` claim
in the same completion transaction. All persisted article summaries now use
this task contract, as described below.

Deploy compatible worker registrations before enabling these producers, and
retain both task names and payload schemas while their messages remain queued,
including when migrating the other summary triggers. Rolling back to a worker
without these registrations drops unknown messages: drain or retain a
compatible worker rather than relying on rollback to recover them. No database
migration is required beyond the common application-task infrastructure.

### Article summary tasks

Article creation, body/language edits, human translation publication, and
completed automatic translations persist summary claims and task intents in the
same database transaction as the corresponding content. The API only produces
work; it does not call the summarizer. The worker awaits the LLM and atomic
updates of article content, reader variants, and the original-language
`post.summary` before acknowledging completion. Additional human translations
published together with the original retain their existing trigger coverage.

The shared descriptor is `articleSummaryTask`. Its wire name remains
`article.translation-summary.v1`, with the existing source ID, language, and
millisecond ISO claim schema, so previously queued messages and workers remain
compatible. Keep this registration while messages or replayable dead letters
exist. Ordering keys remain `article-summary:<sourceId>:<language>`.

Claims use the database clock. The handler reads current content and skips
completed, deleted, superseded, unnecessary, and translation-placeholder jobs
without an LLM call. Persistence compares the exact body handed to the LLM,
checks claim ownership, and holds the source lock before changing content or
mirrors. Empty summaries and results that are not shorter than visible input
(after `<details>` filtering) are terminal discards marked `summaryUnnecessary`.

LLM and database exceptions reach the queue's bounded three-attempt policy.
Failures and cancellations retain the claim: the same payload retries on the
queue's backoff without waiting for the 30-minute stale-claim threshold. A
superseded task completes as a no-op on its next attempt, releasing its
ordering key for newer work. Invalid task names/payloads are terminal dead
letters. Queue logs and `last_error` expose failures; use the application-task
inspection and replay commands above after fixing the underlying problem.
Replay of a completed or superseded summary does not regenerate it. Exhausted
tasks retain claims until replay or a body/language edit requests new work;
title-only edits do not restart summary generation.

Worker termination during generation is recovered after lease expiry. A worker
terminated after summary persistence but before acknowledgement finds completed
content on retry and skips the LLM. Cancellation before transaction commit
rolls back all summary writes and can repeat an LLM call on recovery. Neither
this migration nor the translation migration provides a periodic summary
recovery scan. Legacy in-process claims without a queued intent require a
body/language edit or an explicit `startArticleContentSummary` call after the
existing 30-minute reclaim threshold.


Passkey-only accounts and recovery
----------------------------------

Apply the `account_passkey_only` migration before deploying this feature.
Existing accounts keep email sign-in enabled and generation zero; existing
sessions without an authentication method are treated as email sessions.
Enabling passkey-only sign-in invalidates those sessions and outstanding email
login links. A later return to email sign-in does not revive revoked
credentials.

Users enable the setting in Settings → Passkeys after registering at least one
passkey. Activation issues ten one-time recovery codes and shows them only
once. Only hashes are stored. Users must save these codes offline, separately
from passkeys. Adding or removing passkeys while email sign-in is disabled
requires a fresh assertion from an existing passkey; the last passkey cannot be
removed. Native clients retain their existing passkey login API, but must adopt
the additive security-proof arguments for strict-mode passkey management.

A user who loses access to every passkey can choose “Sign in with a recovery
code” on the sign-in page. Recovery consumes one code, keeps email sign-in
disabled, and issues a separate, single-use registration authorization lasting
ten minutes. The recovery screen immediately offers registration of a
replacement passkey. Leaving or refreshing the page loses that authorization;
another unused recovery code can start a new attempt. A recovery session alone
cannot register a key, restore email sign-in, or regenerate codes. Code
regeneration and restoring email sign-in invalidate recovery sessions and
outstanding recovery registration authorizations. Recovery sessions without a
security generation are rejected. When a recovery user proves possession of a
passkey to change these settings, the response returns a new passkey session;
clients must replace their cookie or bearer token before further requests.
Existing passkey sessions remain valid.

Do not offer recovery through email: that would bypass the user's selected
security policy. If all passkeys and codes are lost, there is no standard
recovery path. An administrator may make a manual exception only for someone
they personally know and trust, after independently verifying their identity.
Email access or a support request alone is insufficient; users must not rely on
this exception for recovery. No new administrator recovery endpoint is provided.

Every application role serving authenticated requests must enforce the new
session-generation check. Do not roll back to a version that lacks it while
passkey-only accounts exist: that version would accept their old email sessions
and links. The feature does not change Fedify delivery or worker ownership.


Ordered hashtag search
----------------------

Apply `20261106104307_ordered_hashtag_search` before starting application code
that uses `post_hashtag`. The migration takes a `SHARE ROW EXCLUSIVE` lock on
`post` through the backfill, index construction, trigger installation, and
`ANALYZE`. Ordinary reads can continue, but existing write transactions can
delay the lock and new writers queue behind it. Rehearse on a representative
staging copy and schedule a quiet window based on the lock duration measured
there.

Apply the migration-only timeout override after mise loads `.env`, which can
replace an externally supplied `DATABASE_URL`. Run this from the repository
directory with the target database configured:

~~~~ sh
mise exec -- node --input-type=module <<'JS'
import { spawnSync } from "node:child_process";
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set("statement_timeout", "0");
const result = spawnSync("pnpm", ["exec", "drizzle-kit", "migrate"], {
  env: { ...process.env, DATABASE_URL: url.href },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
JS
~~~~

The URL startup parameter was verified on the actual Drizzle Kit/Postgres.js
connection; the tested runner did not consume the libpq `PGOPTIONS` override
used by the `psql` examples above. The command preserves other URL parameters
and the normal application connection's timeout settings.

The single `DO` statement keeps the lock, backfill, and synchronization atomic
regardless of the migration runner's transaction boundaries. A timeout rolls
back the relation, functions, triggers, and migration receipt, allowing a
retry. Old application writers are covered by the triggers after commit. The
additive relation and triggers can remain when rolling the application back.

See [the benchmark and migration rehearsal](benchmarks/hashtag-search.md) for
local write/storage costs, query-plan evidence, and the remaining
high-rejection search cost. Local synthetic timings are not production lock
estimates.


Anonymous web read admission
----------------------------

The API limits concurrent expensive guest GraphQL queries before opening their
snapshot transactions. The limit covers queries arriving directly or through
web-next, including distinct parameters and multiple client addresses. It does
not apply a blanket cache or throttle to `/_server`. Mutations, authenticated
query execution, and ActivityPub HTTP traffic have separate behavior. This is
separate from protocol-process isolation (#443) and does not add SSR deadlines
(#444).

Excess requests receive HTTP `503 Service Unavailable`, `Retry-After: 1`,
`Cache-Control: no-store`, and GraphQL code `ANONYMOUS_READ_OVERLOADED`. There
is no queue for distinct queries. A disconnected caller stops waiting, but its
execution slot remains occupied until its actual resolver, SQL, external
lookup, snapshot retry, and after-commit work finishes. Cancellation reaches
supported PostgreSQL queries and mention lookups. Dependencies that ignore
cancellation retain their slot until completion.

These settings are validated at API startup. They do not change the worker's
configuration:

| Variable                          | Default | Meaning                                                           |
| --------------------------------- | ------- | ----------------------------------------------------------------- |
| `ANONYMOUS_READ_GLOBAL_LIMIT`     | `8`     | Expensive guest executions across API replicas sharing the ledger |
| `ANONYMOUS_READ_LOCAL_LIMIT`      | `4`     | Executing, acquiring, or draining guest leaders per API process   |
| `ANONYMOUS_READ_FOLLOWER_LIMIT`   | `32`    | Additional callers awaiting shared work per API process           |
| `ANONYMOUS_READ_AUTH_LIMIT`       | `32`    | Concurrent credential-validation contexts per API process         |
| `ANONYMOUS_READ_CHEAP_LIMIT`      | `32`    | DB-free guest query executions per API process                    |
| `ANONYMOUS_READ_REDIS_TIMEOUT_MS` | `1000`  | Dedicated admission connection/command timeout                    |
| `ANONYMOUS_READ_JOIN_WINDOW_MS`   | `25`    | Time after group creation during which a matching caller can join |

The DB-free lane recognizes the actual guest fields `viewer` (always `null`),
`webPushVapidPublicKey`, `suggestedFilterLanguages`, and `__typename`,
including aliases and fragments. A query containing any other root field uses
normal admission. The guest root layout used by sign-in therefore needs no
database transaction. Credential-free requests do not compete for the
credential-validation lane. Forged UUID credentials remain bounded in that
lane, and never establish an authenticated bypass. Genuine credentials still
compete with forged ones for validation; these limits do not guarantee
availability against every attack.

With two API processes, the defaults allow at most eight expensive guest
executions globally, at most four per process, and up to 64 additional shared
callers across the two processes. Each API process's existing PostgreSQL pool
still has 20 connections. Admission does not change that pool size, the
worker's pool, or other applications' database budgets; account for all of them
when sizing the host. Parsing, validation, synchronous CPU work, mutations, and
authenticated traffic are not covered by this guest execution bound.

### Provision the ownership ledger before cutover

Production uses a dedicated Redis client against `KV_URL`. API replicas must
share the same Redis database, canonical `ORIGIN`, and global limit. The ledger
stores its format, limit, and owner identifiers, never query results, session
tokens, or variables. Serving processes never create or erase it. A missing
ledger, or a ledger whose format or limit does not match, prevents interactive
and combined HTTP processes from starting. Before listening, each process
validates the ledger without acquiring a slot or changing any owners. A valid
ledger at full capacity still permits startup. Startup errors identify the
store failure, ledger key, and expected limit; use the drained recovery
procedure below.

Known store failures after startup make `/health` return
[`503 Service Unavailable`] and close expensive guest admission while other
lanes can continue. Use `mise run prod:hc:graphql` for API health checks: a
protocol endpoint or the cheap `{__typename}` query alone cannot detect
disabled guest admission. Ledger deletion or metadata changes are detected by
the next slot acquisition or release, not by a background ledger poll.

This design requires authoritative Redis state to be retained: use
`maxmemory-policy noeviction`, durable storage, and a failover policy that does
not discard acknowledged ownership. Redis restart, restore, stale-replica
failover, `FLUSHDB`, or manual key deletion while old work can still run can
invalidate the global bound. The application cannot fence such state loss.
Drain all API work before these operations; do not treat a restored Redis
connection as recovery.

For the initial installation, stop/drain all API replicas and confirm their SQL
and external work has ended. Run the following from the repository root with
production `ORIGIN` and `KV_URL` set, then initialize the absent ledger
atomically:

~~~~ bash
mise exec -- bash <<'SH'
set -eu
admission_key=$(node --input-type=module -e '
  import { anonymousReadLedgerKey } from "./runtime/anonymous-read-admission.ts";
  console.log(anonymousReadLedgerKey(new URL(process.env.ORIGIN)));
')
redis-cli -u "$KV_URL" EVAL '
  if redis.call("EXISTS", KEYS[1]) ~= 0 then
    return redis.error_reply("ledger already exists; inspect it before recovery")
  end
  redis.call("HSET", KEYS[1], "format", "1", "limit", ARGV[1])
  return "initialized"
' 1 "$admission_key" "${ANONYMOUS_READ_GLOBAL_LIMIT:-8}"
SH
~~~~

Start all API replicas with matching settings afterward. The explicitly allowed
file-KV development mode uses a process-local memory store and provides no
cross-process bound; it is not a production fallback.

After an unplanned Redis restart or failover, use the full recovery procedure
below; restoring connectivity alone is insufficient. A missing or mismatched
ledger returns the same retryable overload response.

A command timeout or uncertain acquire/release permanently closes that
process's admission client and disconnects it. It does not retry, queue offline
commands, reconnect, or expire a possibly live owner. This may conservatively
leave occupied slots after a process crash or failed release. To recover or
change the global limit:

1.  Stop admission by draining/stopping **all** API replicas, including old
    rollout replicas. Confirm old SQL/external work has ended.
2.  Run only the `node` command inside the initialization script to print the
    exact ledger key. Inspect that key with `HGETALL`, and remove **only that
    key** with `DEL` if reinitialization is necessary. Do not flush the
    session/federation Redis database.
3.  Run the initialization script with `ANONYMOUS_READ_GLOBAL_LIMIT` set to the
    intended limit, then start all replicas with matching settings. Starting a
    new API process does not clear ownership held by a surviving process.

### Sharing and visibility policy

Only complete, audited versions of the web UI's `newsPageQuery` and
`NewsListQuery` can share an in-flight execution within one API process.
Identity includes the selected document, all variables (including cursor,
order, filters, and locale when supplied), origin, `Accept-Language`, and error
propagation policy. Credential-bearing requests, authenticated responses,
mutations, and other documents never share. Changed frontend selections safely
fall back to independent bounded execution until their audit is updated.

There is no completed-response cache. Group members receive separate response
and error objects. A caller's disconnect does not cancel other members; the
last member's disconnect closes membership and cancels the group. Subscriber
counts, distinct groups, and pending Redis commands have finite bounds.

Members of an overlapping cohort observe its leader's snapshot. A deletion,
moderation decision, or visibility change committed after that snapshot starts
may therefore not be reflected in that cohort. The join window limits when
members attach, not how long an already-running snapshot can take to finish. A
later independent execution rereads current data under the existing field
visibility rules and derived news-index update policy. No result is retained
after execution, and no immediate invalidation or maximum snapshot-delivery
delay is promised. Persistent public-content caching is deferred until shared
write invalidation can be provided safely.

### Observe and validate

Every 30 seconds each API process logs one structured
`Anonymous read admission` record with limits, active/acquiring work,
followers, authentication/cheap occupancy, admitted/completed/cancelled/shared
totals, rejection counts by reason, and the store failure reason. `queued` is
always zero. No per-request query, identity, or variables are logged. Inspect
`HGETALL` for ledger metadata and owners; `HLEN` minus the two metadata fields
gives global occupied slots, including conservative leaks.

Focused tests exercise actual GraphQL Yoga responses, current Relay news
documents, PostgreSQL work ownership, Redis cross-client limits, stalled
commands, cancellation, and subsequent visibility checks. Run them with the
test database:

~~~~ bash
mise exec -- godotenv -f .env.test -o node --import temporal-polyfill/global \
  --test 'graphql/anonymous-read*.test.ts' 'graphql/request-work.test.ts' \
  'models/*request-work.test.ts' 'models/actor-lookup-work.test.ts' \
  'runtime/anonymous-read*.test.ts' 'runtime/sql-work*.test.ts' \
  'test/anonymous-read-replay.test.ts'
~~~~

The deterministic replay test reports admitted concurrency, work starts,
followers, zero queue size, overload responses, and interactive latency. Before
production cutover, also replay representative repeated/distinct public reads
from many identities on staging while browsing and signing in. Record baseline
and loaded p95/p99 latency, errors, and database calls against the deployment's
agreed SLO. Local fixtures do not establish production latency or prove what
caused the November 2026 incident.

Graceful API shutdown waits for owned anonymous work to finish before disposing
Yoga or closing the Redis admission client and database resources. This can
outlast the HTTP connection drain when a dependency ignores cancellation.
Allow that work to finish during a planned rollout. A forced process kill is a
crash and can leave conservative owner records requiring the recovery procedure
above. For admitted reads, normal inbound cancellation does not create a Sentry
exception; unrelated upstream or application errors remain reportable.
