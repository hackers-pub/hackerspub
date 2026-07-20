// Must be the first import — see instrument.ts for the rationale.
import "./instrument.ts";
import "./logging.ts";

import { sweepExpiredSuspensionRescores } from "@hackerspub/models/moderation";
import {
  drainNewsRescoreQueue,
  recomputeNewsScores,
} from "@hackerspub/models/news";
import {
  migrateLegacyOutboxEvents,
  pruneOutboxEvents,
} from "@hackerspub/models/outbox";
import { notifyEndedPolls } from "@hackerspub/models/poll";
import { getLogger } from "@logtape/logtape";
import {
  getDenoEnvironment,
  loadServerConfig,
} from "@hackerspub/runtime/config";
import { createRuntimeResources } from "@hackerspub/runtime/resources";
import { sql } from "drizzle-orm";
import { sendNotificationDigests } from "./notification-digest.ts";
import { services } from "./services.ts";
import {
  DEFAULT_WORKER_HEALTH_FILE,
  startWorkerHeartbeat,
} from "./worker-health.ts";
import metadata from "./deno.json" with { type: "json" };

const resources = await createRuntimeResources(
  loadServerConfig(getDenoEnvironment()),
  metadata.version,
  {
    fileSystemBaseUrl: new URL("./", import.meta.url),
    federation: { manuallyStartQueue: true },
  },
);
const { db, drive, email, federation, kv, models } = resources;

const logger = getLogger(["hackerspub", "graphql", "worker"]);

// One controller coordinates graceful shutdown of BOTH long-lived tasks below
// (the news cron and the queue consumer).  Registering signal listeners
// overrides Deno's default termination, so every long-lived task must observe
// this signal; otherwise the process would hang on shutdown (or run another
// sweep mid-shutdown) instead of draining and exiting.
const controller = new AbortController();
const signalListeners: Array<{
  readonly signal: "SIGINT" | "SIGTERM";
  readonly listener: () => void;
}> = [];
for (const signalName of ["SIGINT", "SIGTERM"] as const) {
  const listener = () => {
    logger.info(
      "Received {signal}; shutting down the queue worker gracefully.",
      { signal: signalName },
    );
    controller.abort();
  };
  Deno.addSignalListener(signalName, listener);
  signalListeners.push({ signal: signalName, listener });
}

// Periodic news-score sweep.  The write hook re-scores a link only when the
// link itself is (un)shared, so engagement-driven re-ranking (a new reply,
// quote, or reaction on an existing story) relies on this sweep.  It recomputes
// links with any activity since the window, derived from source timestamps.
// The moderator "recompute" mutation is the authoritative full rebuild and
// reconciles anything the incremental/sweep paths miss.  Scoped to
// `activeSince` to bound cost.  Runs in this worker process (not the API
// process and not `mod.ts`) so the API event loop carries no background work
// and codegen/tests never register it.
const newsLogger = getLogger(["hackerspub", "graphql", "news"]);
// One hour. The sweep runs every 5 minutes and only needs to catch activity
// since the previous successful run; queue-backed write paths cover immediate
// rescoring for direct link changes. A 24-hour window became too large under
// production load and hit the statement timeout (GRAPHQL-1P).
const NEWS_SWEEP_ACTIVE_WINDOW_MS = 60 * 60 * 1000;
// Arbitrary fixed id for the advisory lock that serializes the sweep across
// replicas ("news" read as a 32-bit int).
const NEWS_SWEEP_LOCK_KEY = 0x6e657773;
Deno.cron("recompute-news-scores", "*/5 * * * *", {
  // Unschedule on shutdown so the worker can drain and exit instead of being
  // kept alive (or firing another sweep) by the still-scheduled cron.
  signal: controller.signal,
}, async () => {
  try {
    const activeSince = new Date(Date.now() - NEWS_SWEEP_ACTIVE_WINDOW_MS);
    // Every worker replica fires this cron at the same instant. Run by itself
    // the recompute finishes well within the statement timeout, but several of
    // them at once queue behind one another's `post_link` row locks and the
    // waiters time out. Gate the sweep on a transaction-scoped advisory lock so
    // exactly one replica runs it per tick and the rest skip immediately; the
    // lock is released when the transaction ends.
    const linksUpdated = await db.transaction(async (tx) => {
      const rows = await tx.execute(
        sql`select pg_try_advisory_xact_lock(${NEWS_SWEEP_LOCK_KEY}::bigint) as locked`,
      ) as unknown as { locked: boolean }[];
      if (rows[0]?.locked !== true) return null;
      const result = await recomputeNewsScores(tx, { activeSince });
      return result.linksUpdated;
    });
    if (linksUpdated == null) {
      newsLogger.debug("News score sweep skipped; another replica holds it.");
    } else {
      newsLogger.debug("News score sweep updated {linksUpdated} link(s).", {
        linksUpdated,
      });
    }
  } catch (error) {
    newsLogger.error("News score sweep failed: {error}", { error });
  }
});

// Drain the News rescore queue.  Curating or un-curating a preferred sharer
// enqueues the actor (in the API process) instead of rescoring its links inline,
// which would blow past the request statement timeout for a high-volume feed
// bot.  This drains that backlog off the request path, in chunks.  It fires
// every minute (not on the 5-minute sweep) so a moderator's change surfaces
// quickly.  `drainNewsRescoreQueue` leases each actor with `for update skip
// locked`, so running it on every replica's cron is safe (replicas claim
// disjoint actors); no advisory lock like the sweep above.
Deno.cron("drain-news-rescore-queue", "* * * * *", {
  signal: controller.signal,
}, async () => {
  try {
    // Suspension expiry is lazy, so nothing fires at the expiry instant;
    // sweep for remote suspensions that expired since the last successful
    // sweep (durable watermark in admin_state) and queue their news
    // signals for recomputation before draining.
    await sweepExpiredSuspensionRescores(db);
    const { actorsProcessed, linksRecomputed } = await drainNewsRescoreQueue(
      db,
    );
    if (actorsProcessed > 0) {
      newsLogger.debug(
        "Drained {actorsProcessed} news rescore(s); recomputed " +
          "{linksRecomputed} link(s).",
        { actorsProcessed, linksRecomputed },
      );
    }
  } catch (error) {
    newsLogger.error("News rescore drain failed: {error}", { error });
  }
});

const pollLogger = getLogger(["hackerspub", "graphql", "poll"]);
Deno.cron("notify-ended-polls", "* * * * *", {
  signal: controller.signal,
}, async () => {
  try {
    const { pollsProcessed, notificationsCreated } = await notifyEndedPolls(
      db,
    );
    if (pollsProcessed > 0) {
      pollLogger.debug(
        "Notified ended poll results for {pollsProcessed} poll(s); " +
          "created {notificationsCreated} notification(s).",
        { pollsProcessed, notificationsCreated },
      );
    }
  } catch (error) {
    pollLogger.error(
      "Ended poll notification drain failed for {jobName}: {error}",
      { jobName: "notify-ended-polls", error },
    );
  }
});

const digestLogger = getLogger([
  "hackerspub",
  "graphql",
  "notification-digest",
]);

async function sendNotificationDigestJob(frequency: "daily" | "weekly") {
  return await sendNotificationDigests({
    db,
    email,
    from: resources.config.email.from,
    origin: resources.config.origin.href,
    frequency,
  });
}

Deno.cron("send-weekly-notification-digests", "0 0 * * 1", {
  signal: controller.signal,
}, async () => {
  try {
    const result = await sendNotificationDigestJob("weekly");
    digestLogger.debug(
      "Processed weekly notification digests: {result}",
      { result },
    );
  } catch (error) {
    digestLogger.error("Weekly notification digest job failed: {error}", {
      error,
    });
  }
});

Deno.cron("send-daily-notification-digests", "5 0 * * *", {
  signal: controller.signal,
}, async () => {
  try {
    const result = await sendNotificationDigestJob("daily");
    digestLogger.debug(
      "Processed daily notification digests: {result}",
      { result },
    );
  } catch (error) {
    digestLogger.error("Daily notification digest job failed: {error}", {
      error,
    });
  }
});

const outboxLogger = getLogger([
  "hackerspub",
  "graphql",
  "transactional-outbox",
]);
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
Deno.cron("prune-transactional-outbox", "30 3 * * *", {
  signal: controller.signal,
}, async () => {
  try {
    const now = Date.now();
    const deleted = await pruneOutboxEvents(db, {
      completedBefore: new Date(now - DAY_MILLISECONDS),
      failedBefore: new Date(now - 30 * DAY_MILLISECONDS),
    });
    if (deleted > 0) {
      outboxLogger.info("Pruned {deleted} expired outbox event(s).", {
        deleted,
      });
    }
  } catch (error) {
    outboxLogger.error("Transactional outbox pruning failed: {error}", {
      error,
    });
  }
});

// Drain the federation inbox and transactional fanout/delivery queues.  The
// API process (`main.ts`) builds the same federation with
// `manuallyStartQueue: true` and only enqueues, so
// this dedicated process is the sole consumer on the new (graphql) stack side.
// Running it apart from the API gives the heavy, bursty federation work its own
// event loop and DB pool, so a slow/zombie inbox handler can no longer starve
// user-facing GraphQL requests into Caddy 504s (WEB-NEXT-1W).  This worker must
// NOT be placed behind a load balancer (Fedify: each worker takes the queue
// independently).
const disk = drive.use();
logger.info("Starting the federation message queue worker.");
let queueFailed = false;
let queueError: unknown;
try {
  await migrateLegacyOutboxEvents(db);
  const queue = federation.startQueue(
    { db, kv, disk, models, services },
    { signal: controller.signal },
  );
  const heartbeat = await startWorkerHeartbeat(
    Deno.env.get("WORKER_HEALTH_FILE") ?? DEFAULT_WORKER_HEALTH_FILE,
  );
  try {
    await queue;
    logger.info("The federation message queue worker has stopped.");
  } finally {
    await heartbeat.stop();
  }
} catch (error) {
  queueFailed = true;
  queueError = error;
}
for (const { signal, listener } of signalListeners) {
  Deno.removeSignalListener(signal, listener);
}
let closeFailed = false;
let closeError: unknown;
try {
  await resources.close();
} catch (error) {
  closeFailed = true;
  closeError = error;
}
if (queueFailed) {
  if (closeFailed) {
    throw new AggregateError(
      [queueError, closeError],
      "The federation queue worker failed and its resources could not be closed.",
    );
  }
  throw queueError;
}
if (closeFailed) throw closeError;
