import { getLogger } from "@logtape/logtape";
import { sweepExpiredSuspensionRescores } from "@hackerspub/models/moderation";
import {
  drainNewsRescoreQueue,
  recomputeNewsScores,
} from "@hackerspub/models/news";
import { pruneOutboxEvents } from "@hackerspub/models/outbox";
import { notifyEndedPolls } from "@hackerspub/models/poll";
import type { Database } from "@hackerspub/models/db";
import type { Transport } from "@upyo/core";
import { sql } from "drizzle-orm";
import { sendNotificationDigests } from "./notification-digest.ts";

export interface WorkerJob {
  readonly name: string;
  readonly schedule: string;
  run(): Promise<void>;
}

interface WorkerJobSchedule {
  readonly name: string;
  readonly schedule: string;
}

export const WORKER_JOB_SCHEDULES = {
  recomputeNewsScores: {
    name: "recompute-news-scores",
    schedule: "*/5 * * * *",
  },
  drainNewsRescoreQueue: {
    name: "drain-news-rescore-queue",
    schedule: "* * * * *",
  },
  notifyEndedPolls: {
    name: "notify-ended-polls",
    schedule: "* * * * *",
  },
  sendWeeklyNotificationDigests: {
    name: "send-weekly-notification-digests",
    schedule: "0 0 * * 1",
  },
  sendDailyNotificationDigests: {
    name: "send-daily-notification-digests",
    schedule: "5 0 * * *",
  },
  pruneTransactionalOutbox: {
    name: "prune-transactional-outbox",
    schedule: "30 3 * * *",
  },
} as const satisfies Record<string, WorkerJobSchedule>;

export interface WorkerJobResources {
  readonly db: Database;
  readonly email: Transport;
  readonly emailFrom: string;
  readonly origin: string;
}

export interface WorkerJobOperations {
  readonly sweepExpiredSuspensionRescores: typeof sweepExpiredSuspensionRescores;
  readonly drainNewsRescoreQueue: typeof drainNewsRescoreQueue;
  readonly recomputeNewsScores: typeof recomputeNewsScores;
  readonly notifyEndedPolls: typeof notifyEndedPolls;
  readonly sendNotificationDigests: typeof sendNotificationDigests;
  readonly pruneOutboxEvents: typeof pruneOutboxEvents;
}

export interface WorkerJobOptions {
  readonly now?: () => Date;
  readonly operations?: Partial<WorkerJobOperations>;
}

interface WorkerJobErrorLogger {
  error(message: string, properties: Record<string, unknown>): void;
}

const defaultOperations: WorkerJobOperations = {
  sweepExpiredSuspensionRescores,
  drainNewsRescoreQueue,
  recomputeNewsScores,
  notifyEndedPolls,
  sendNotificationDigests,
  pruneOutboxEvents,
};

const newsLogger = getLogger(["hackerspub", "graphql", "news"]);
const pollLogger = getLogger(["hackerspub", "graphql", "poll"]);
const digestLogger = getLogger([
  "hackerspub",
  "graphql",
  "notification-digest",
]);
const outboxLogger = getLogger([
  "hackerspub",
  "graphql",
  "transactional-outbox",
]);
const schedulerLogger = getLogger([
  "hackerspub",
  "graphql",
  "worker",
  "scheduler",
]);

// Surface slow shutdown early while keeping shared resources available until
// active jobs settle.
export const WORKER_JOB_DRAIN_WARNING_MILLISECONDS = 3_000;

export async function waitForWorkerJobsToDrain(
  drain: () => Promise<void>,
  warningAfterMilliseconds: number,
  warn: () => void,
): Promise<void> {
  const warning = setTimeout(warn, warningAfterMilliseconds);
  try {
    await drain();
  } finally {
    clearTimeout(warning);
  }
}

// One hour. The sweep runs every 5 minutes and only needs to catch activity
// since the previous successful run; queue-backed write paths cover immediate
// rescoring for direct link changes. A 24-hour window became too large under
// production load and hit the statement timeout (GRAPHQL-1P).
const NEWS_SWEEP_ACTIVE_WINDOW_MILLISECONDS = 60 * 60 * 1000;
// Arbitrary fixed id for the advisory lock that serializes the sweep across
// replicas ("news" read as a 32-bit int).
const NEWS_SWEEP_LOCK_KEY = 0x6e657773;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export function createWorkerJobs(
  resources: WorkerJobResources,
  options: WorkerJobOptions = {},
): readonly WorkerJob[] {
  const now = options.now ?? (() => new Date());
  const operations = { ...defaultOperations, ...options.operations };
  const { db, email, emailFrom, origin } = resources;

  return [
    {
      ...WORKER_JOB_SCHEDULES.recomputeNewsScores,
      async run() {
        const activeSince = new Date(
          now().getTime() - NEWS_SWEEP_ACTIVE_WINDOW_MILLISECONDS,
        );
        // Every worker replica fires this cron at the same instant. Run by
        // itself the recompute finishes within the statement timeout, but
        // several replicas queue behind one another's `post_link` row locks.
        // Gate the sweep on a transaction-scoped advisory lock so exactly one
        // replica runs per tick and the rest skip immediately.
        const linksUpdated = await db.transaction(async (tx) => {
          const rows = (await tx.execute(
            sql`select pg_try_advisory_xact_lock(${NEWS_SWEEP_LOCK_KEY}::bigint) as locked`,
          )) as unknown as { locked: boolean }[];
          if (rows[0]?.locked !== true) return null;
          const result = await operations.recomputeNewsScores(tx, {
            activeSince,
          });
          return result.linksUpdated;
        });
        if (linksUpdated == null) {
          newsLogger.debug(
            "News score sweep skipped; another replica holds it.",
          );
        } else {
          newsLogger.debug("News score sweep updated {linksUpdated} link(s).", {
            linksUpdated,
          });
        }
      },
    },
    {
      ...WORKER_JOB_SCHEDULES.drainNewsRescoreQueue,
      async run() {
        // Suspension expiry is lazy, so sweep for newly expired remote
        // suspensions before draining. Each drain leases actors with
        // `for update skip locked`, giving replicas disjoint work without an
        // advisory lock.
        await operations.sweepExpiredSuspensionRescores(db);
        const { actorsProcessed, linksRecomputed } =
          await operations.drainNewsRescoreQueue(db);
        if (actorsProcessed > 0) {
          newsLogger.debug(
            "Drained {actorsProcessed} news rescore(s); recomputed " +
              "{linksRecomputed} link(s).",
            { actorsProcessed, linksRecomputed },
          );
        }
      },
    },
    {
      ...WORKER_JOB_SCHEDULES.notifyEndedPolls,
      async run() {
        const { pollsProcessed, notificationsCreated } =
          await operations.notifyEndedPolls(db);
        if (pollsProcessed > 0) {
          pollLogger.debug(
            "Notified ended poll results for {pollsProcessed} poll(s); " +
              "created {notificationsCreated} notification(s).",
            { pollsProcessed, notificationsCreated },
          );
        }
      },
    },
    {
      ...WORKER_JOB_SCHEDULES.sendWeeklyNotificationDigests,
      async run() {
        const result = await operations.sendNotificationDigests({
          db,
          email,
          from: emailFrom,
          origin,
          frequency: "weekly",
        });
        digestLogger.debug("Processed weekly notification digests: {result}", {
          result,
        });
      },
    },
    {
      ...WORKER_JOB_SCHEDULES.sendDailyNotificationDigests,
      async run() {
        const result = await operations.sendNotificationDigests({
          db,
          email,
          from: emailFrom,
          origin,
          frequency: "daily",
        });
        digestLogger.debug("Processed daily notification digests: {result}", {
          result,
        });
      },
    },
    {
      ...WORKER_JOB_SCHEDULES.pruneTransactionalOutbox,
      async run() {
        const current = now().getTime();
        const deleted = await operations.pruneOutboxEvents(db, {
          completedBefore: new Date(current - DAY_MILLISECONDS),
          failedBefore: new Date(current - 30 * DAY_MILLISECONDS),
        });
        if (deleted > 0) {
          outboxLogger.info("Pruned {deleted} expired outbox event(s).", {
            deleted,
          });
        }
      },
    },
  ];
}

export class WorkerJobRunner {
  readonly #active = new Set<Promise<void>>();
  readonly #logger: WorkerJobErrorLogger;

  constructor(logger: WorkerJobErrorLogger = schedulerLogger) {
    this.#logger = logger;
  }

  run(job: WorkerJob): Promise<void> {
    const execution = Promise.resolve()
      .then(() => job.run())
      .catch((error) => {
        this.#logger.error("Scheduled worker job {jobName} failed: {error}", {
          jobName: job.name,
          error,
        });
      })
      .finally(() => {
        this.#active.delete(execution);
      });
    this.#active.add(execution);
    return execution;
  }

  async drain(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.all(this.#active);
    }
  }
}
