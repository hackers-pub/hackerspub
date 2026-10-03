import { getLogger } from "@logtape/logtape";
import type { ApplicationContext } from "@hackerspub/models/context";
import { runInTransaction } from "@hackerspub/models/db";
import { scheduledWorkerDispatchTable } from "@hackerspub/models/schema";
import {
  scheduledWorkerTask,
  SCHEDULED_WORKER_JOB_NAMES,
  type ScheduledWorkerTaskPayload,
} from "@hackerspub/models/tasks";
import { lt } from "drizzle-orm";
import type { WorkerJob } from "./worker-jobs.ts";

const logger = getLogger(["hackerspub", "graphql", "worker", "scheduler"]);

/** A committed watermark always has a durable intent in the same transaction. */
export async function dispatchScheduledWorkerJob(
  context: ApplicationContext,
  data: ScheduledWorkerTaskPayload,
): Promise<boolean> {
  const validated = scheduledWorkerTask.schema["~standard"].validate(data);
  if (validated.issues != null)
    throw new TypeError(validated.issues[0].message);
  const scheduled = new Date(data.scheduled);
  return await runInTransaction(context.db, async (tx) => {
    const rows = await tx
      .insert(scheduledWorkerDispatchTable)
      .values({
        jobName: data.jobName,
        scheduled,
      })
      .onConflictDoUpdate({
        target: scheduledWorkerDispatchTable.jobName,
        set: { scheduled },
        setWhere: lt(scheduledWorkerDispatchTable.scheduled, scheduled),
      })
      .returning();
    if (rows.length === 0) return false;
    await context.withDatabase(tx).enqueueTask(scheduledWorkerTask, data, {
      orderingKey: `scheduled:${data.jobName}`,
    });
    return true;
  });
}

/** The news rescore drain already consumes durable, independently leased rows. */
export function createWorkerDispatchJobs(
  context: ApplicationContext,
  jobs: readonly WorkerJob[],
): readonly WorkerJob[] {
  return jobs.map((job) => {
    const jobName = SCHEDULED_WORKER_JOB_NAMES.find(
      (name) => name === job.name,
    );
    if (jobName == null) return job;
    return {
      name: job.name,
      schedule: job.schedule,
      async run(scheduled = new Date()) {
        const dispatched = await dispatchScheduledWorkerJob(context, {
          jobName,
          scheduled: scheduled.toISOString(),
        });
        logger.debug(
          "Scheduled worker tick {jobName} at {scheduled}: {dispatch}.",
          {
            jobName,
            scheduled,
            dispatch: dispatched ? "intent persisted" : "already dispatched",
          },
        );
      },
    };
  });
}
