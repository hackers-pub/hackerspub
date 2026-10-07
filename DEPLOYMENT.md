Deployment
==========

This document describes how Hackers' Pub is deployed, how to cut over to a new
build, and how to roll one back.  For local development, read
[*CONTRIBUTING.md*](./CONTRIBUTING.md) instead.


Roles
-----

One container image serves three roles.  They are separate processes with
separate lifecycles, and the deployment definition chooses which role a
container runs and which probe watches it:

| Role   | Start command                  | Health check                      | Port |
| ------ | ------------------------------ | --------------------------------- | ---- |
| API    | `mise run prod:graphql`        | `mise run prod:hc:graphql`        | 8080 |
| Worker | `mise run prod:graphql-worker` | `mise run prod:hc:graphql-worker` | none |
| Web UI | `mise run prod:web-next`       | `mise run prod:hc:web-next`       | 3000 |

The image declares `HEALTHCHECK NONE` precisely because the probes differ per
role; a deployment that omits them gets no health signal at all.

> [!IMPORTANT]
> The worker must run as its own process and must never sit behind a load
> balancer.  It serves no HTTP surface, and its probe reads the heartbeat file
> at `WORKER_HEALTH_FILE` (default */tmp/hackerspub-graphql-worker.health*)
> rather than a port.  Its scheduled jobs coordinate through PostgreSQL locks,
> leases, and idempotent claims, so additional replicas are safe, but each
> needs its own heartbeat path.

The API and the worker must share one Redis instance through `KV_URL`.  A
file-backed `KV_URL` is a development-only convenience and will silently give
the two processes divergent state.


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

5.  A release that switches email delivery from Mailgun to Maileroo needs a
    verified Maileroo sending domain before it starts.  Give the API and
    worker `MAILEROO_KEY` (the domain's sending key) and set `EMAIL_FROM` to an
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

    Installations with articles published before post content variants
    existed also need `mise run migrate:variants` once, after the API is
    running on the new image.  It rebuilds each local article's language
    variants from its published versions, federates nothing, and is safe to
    repeat.

7.  Restart the roles in this order, waiting for each probe to pass before
    continuing: **worker → API → web UI.**  The worker first because it drains
    federation queues and is the only role that can be down without user-facing
    effect; the API before the web UI because the web UI proxies to it.

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

Roll back by redeploying the previously recorded image tag, in reverse
cutover order: **web UI → API → worker**, then rerunning the post-deploy
checks.  The web UI goes first because the newer composer queries fields such
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
verified address.  Verify ownership through an established trusted channel;
do not mark an address verified solely to make the query return no rows.
Accounts with no remaining credentials cannot use Settings to repair their
access.  This feature does not provide a standard recovery procedure.

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
commit.  Rollback removes both state and intent; enqueue failure propagates
and rolls back the transaction.  After commit there is no separate enqueue
step to lose: a worker can poll the intent even if the API crashes immediately.
Do not move this dispatch into the in-memory after-commit callbacks or catch
an enqueue error and continue the transaction.

Payloads are plain JSON identifiers, revisions, and job tokens, validated by
an idempotent Standard Schema on enqueue and dequeue.  Avoid credentials,
vocabulary objects, and other values whose encoding could perform network
I/O inside a transaction.  The application descriptor resolves to the exact
Fedify handle registered on the shared builder.  The handler receives
`(ApplicationContext, payload, { signal, attempt })`; it must await execution,
result persistence, and any follow-up dispatch, and pass `signal` to
cancellable I/O.

Delivery is **at least once**.  Every new enqueue has a new transport ID;
the DB unique index suppresses replay of that transport ID, not independent
requests for the same job.  Each workload must enforce DB-backed claims,
revision checks, and side-effect guards.  Enqueue deduplication is not execution
idempotency.  The `application.probe.v1` task demonstrates this with an
`application_task_receipt` UUID primary key and an idempotent insert.  Receipts
are retained independently of the queue's completed-message retention.

Ordering keys are optional and are namespaced separately from ActivityPub
keys.  The advisory lock taken during enqueue lasts until the caller's
transaction commits.  Acquire multiple keys in a consistent order: otherwise
PostgreSQL can abort a deadlock victim, rolling back its state and intents.
A delayed retry blocks later work with the same key; choose keys only when
that FIFO behavior is required.

### Retries, timeouts, and shutdown

Two queue-owned claim loops execute tasks concurrently, each awaiting its real
handler before acknowledging or claiming another row.  Do not wrap this queue
in Fedify's `ParallelMessageQueue`: that wrapper returns to the backend before
the real handler finishes.

The task backend declares `nativeRetrial: true`, so Fedify rethrows handler
failures and the DB queue owns the retry budget.  The default is three attempts,
with 5-second and 10-second delays before retries.  A hard worker termination
consumes its claimed attempt; repeated terminations cannot cause unlimited
execution.  Per-task Fedify `retryPolicy` does not run on this backend.  Future
workloads needing another budget must configure a dedicated task queue with
`maximumProcessingAttempts` rather than layering a second retry mechanism.

Each task has a 30-minute deadline, a 3-minute lease, and 60-second renewal.
Custom renewal intervals must be shorter than half the lease duration.
A deadline aborts the execution signal with `ApplicationTaskTimeoutError` and
counts as a failure.  Definitive lease loss cancels execution; transient
renewal errors are logged and tolerated until the last successful renewal is
within one heartbeat interval of expiry.  Old lease tokens cannot complete,
retry, or fail a row reclaimed by another worker.  This fence protects queue
state; workload guards must also protect application writes and external
side effects during a network partition.

SIGINT/SIGTERM stops new claims and cancels running handlers.  The worker
waits for the **actual handlers and outstanding lease writes** before closing
resources.  Drained interrupted rows return to `pending` without spending a
failure attempt, including an interruption on the last allowed attempt.
If a deadline or lease failure already cancelled execution before shutdown,
that failure still consumes its attempt.
`last_error.details.interruptions` and structured release logs expose repeated
interruption/starvation.  A handler that returns after cancellation is also
released rather than acknowledged, so an effect committed during drain may
execute again.  Make the entire operation idempotent.

A handler ignoring cancellation can delay shutdown indefinitely.  Its lease
continues renewing while it drains, avoiding overlap with a still-live worker.
Timeout logs identify the event immediately, and later renewal ticks warn
that it is still draining.  The worker health file proves process liveness,
not task progress.  Give the supervisor a stop grace slightly longer than
30 minutes for long LLM jobs, or explicitly accept restart when choosing a
shorter grace.  If draining never ends, terminate the worker with SIGKILL and
restart it; recovery takes up to three minutes after its last successful
renewal.  Plan deploy cadence so long tasks can finish, or pause producers
and drain before deployment.

### Observability and recovery

Fedify emits `fedify.task` spans with `fedify.task.name` and the zero-based
`fedify.task.attempt`, plus the `fedify.queue.task.*` metrics.  The backend
presents its DB attempt count to Fedify without rewriting the stored payload.
On this native-retry backend a retryable handler error records a failed span
on each attempt; a queue retry log and `processing_attempts` distinguish those
from terminal dead letters.  Unknown names and codec/schema failures still
emit Fedify's `unknown_task`, `deserialization`, or `validation` failure reason.
The registered-handler entry guard retains those dropped messages as `dead`
with `TaskDispatchRejectedError`, rather than clearing them as completed.

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
still require it.  The receipt migration can remain in place.  Review
retained dead rows before retiring a registration.  Restore a compatible
worker and replay affected IDs after a mistaken incompatible deployment.

The infrastructure regression suite runs a separate producer and task-only
worker against the test PostgreSQL backend, including SIGKILL both before
persistence and after persistence but before acknowledgment.  It deliberately
runs no cron, email, ActivityPub delivery, or LLM calls. Separate regression
suites cover the migrated translation, summary, and scheduled workloads;
their execution and recovery behavior is documented in the following sections.

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
another connection. Guard rollback cannot erase sent-recipient records.
The worker checks guard liveness and cancellation before claims/sends, awaits
an in-flight send without cancelling it, saves accepted recipients, then
observes cancellation. A retry reclaims unfinished delivery claims immediately
under the guard and skips recipients already saved. If mail succeeds but both
progress and failure-record writes fail, or the process is killed between send
and save, replay may send duplicates. Guard loss during a send has the same
ambiguity. This is at-least-once email delivery, not exactly once.

On shutdown, stop future cron ticks and drain accepted dispatch writes and the
retained rescore drain. Queue shutdown separately waits for actual handlers
and their recipient progress before closing transports/DB resources. Task
payloads contain no credentials; only the worker supplies the execution
capability with runtime email resources. A missing capability fails visibly
and eventually leaves a dead task.

Apply the dispatch-watermark migration before starting new workers. Stop and
drain **all legacy worker schedules and digest sends** before enabling the new
workers: legacy senders do not acquire the digest guard. Avoid a cutover that
straddles the weekly/daily UTC digest ticks because there is no catch-up.
Both roles register `scheduled.worker.v1`; retain this registration and payload
schema on rollback until pending, processing and recoverable dead tasks drain.
An older worker can consume and dead-letter an unknown scheduled task.

Inspect dead scheduled tasks using the common operator CLI and outbox queries.
Later poll/pruning ticks usually cover a failed tick's backlog; a later news
tick recomputes its active window. Decide whether to replay or deliberately
abandon these old ticks using the documented dead-letter procedure. Digest
replay always targets its original period and preserves known recipients.
Do not mistake a dispatch watermark or a later tick for evidence that the
failed task completed.

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
three attempts. The existing 30-minute reader reclaim window also remains:
a reader may supersede a slow active or retrying job with a new token. This can
waste an LLM call; the token and claim checks discard its obsolete result.

Ordinary LLM or persistence failures retain the placeholder and age its claim,
so either a queued retry or a new reader request can recover it immediately.
Cancellation retains the claim for worker recovery. Exhausted tasks retain their
payload in the dead-letter queue. Use the `dead` and `replay` commands above;
replay is useful only while the placeholder still has the payload's token.
A completed, deleted, or superseded job is a no-op. If the original changes
without rotating an unfinished job's token (for example, a title-only edit),
the worker atomically refreshes its placeholder and queues a replacement
instead of leaving it without queued work. Existing placeholders from
before this migration become queued work on their next stale reader request.

A successful translation persists a summary intent and a `summaryStarted`
claim in the same completion transaction. All persisted article summaries now
use this task contract, as described below.

Deploy compatible worker registrations before enabling these producers, and
retain both task names and payload schemas while their messages remain queued,
including when migrating the other summary triggers. Rolling back to a worker
without these registrations drops unknown messages: drain or retain a compatible
worker rather than relying on rollback to recover them. No database migration
is required beyond the common application-task infrastructure.

### Article summary tasks

Article creation, body/language edits, human translation publication, and
completed automatic translations persist summary claims and task intents in
the same database transaction as the corresponding content. The API only
produces work; it does not call the summarizer. The worker awaits the LLM and
atomic updates of article content, reader variants, and the original-language
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
superseded task completes as a no-op on its next attempt, releasing its ordering
key for newer work. Invalid task names/payloads are terminal dead letters.
Queue logs and `last_error` expose failures; use the application-task inspection
and replay commands above after fixing the underlying problem. Replay of a
completed or superseded summary does not regenerate it. Exhausted tasks retain
claims until replay or a body/language edit requests new work; title-only edits
do not restart summary generation.

Worker termination during generation is recovered after lease expiry. A worker
terminated after summary persistence but before acknowledgement finds completed
content on retry and skips the LLM. Cancellation before transaction commit rolls
back all summary writes and can repeat an LLM call on recovery. Neither this
migration nor the translation migration provides a periodic summary recovery
scan. Legacy in-process claims without a queued intent require a body/language
edit or an explicit `startArticleContentSummary` call after the existing
30-minute reclaim threshold.


Passkey-only accounts and recovery
----------------------------------

Apply the `account_passkey_only` migration before deploying this feature.
Existing accounts keep email sign-in enabled and generation zero; existing
sessions without an authentication method are treated as email sessions.
Enabling passkey-only sign-in invalidates those sessions and outstanding email
login links. A later return to email sign-in does not revive revoked
credentials.

Users enable the setting in Settings → Passkeys after registering at least one
passkey. Activation issues ten one-time recovery codes and shows them only once.
Only hashes are stored. Users must save these codes offline, separately from
passkeys. Adding or removing passkeys while email sign-in is disabled requires
a fresh assertion from an existing passkey; the last passkey cannot be removed.
Native clients retain their existing passkey login API, but must adopt the
additive security-proof arguments for strict-mode passkey management.

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
