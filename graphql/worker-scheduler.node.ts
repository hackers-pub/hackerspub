import { Cron } from "croner";
import { getLogger } from "@logtape/logtape";
import {
  type WorkerJob,
  waitForWorkerJobsToDrain,
  WORKER_JOB_DRAIN_WARNING_MILLISECONDS,
  WorkerJobRunner,
} from "./worker-jobs.ts";

export interface NodeCronHandle {
  stop(): void;
}

export type NodeCronFactory = (
  job: WorkerJob,
  run: () => Promise<void>,
  overlap: () => void,
) => NodeCronHandle;

export interface NodeWorkerSchedulerOptions {
  readonly signal: AbortSignal;
  readonly cronFactory?: NodeCronFactory;
  readonly runner?: WorkerJobRunner;
  readonly drainWarningMilliseconds?: number;
  readonly logger?: {
    warning(message: string, properties: Record<string, unknown>): void;
  };
}

const logger = getLogger(["hackerspub", "graphql", "worker", "scheduler"]);

export function createNodeCron(
  job: WorkerJob,
  run: () => Promise<void>,
  overlap: () => void,
): Cron {
  return new Cron(
    job.schedule,
    {
      mode: "5-part",
      protect: overlap,
      timezone: "UTC",
    },
    run,
  );
}

export async function runNodeWorkerScheduler(
  jobs: readonly WorkerJob[],
  options: NodeWorkerSchedulerOptions,
): Promise<void> {
  if (options.signal.aborted) return;

  const runner = options.runner ?? new WorkerJobRunner();
  const cronFactory = options.cronFactory ?? createNodeCron;
  const schedulerLogger = options.logger ?? logger;
  const drainWarningMilliseconds =
    options.drainWarningMilliseconds ?? WORKER_JOB_DRAIN_WARNING_MILLISECONDS;
  const handles: NodeCronHandle[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const handle of handles) handle.stop();
  };
  const drain = () =>
    waitForWorkerJobsToDrain(
      () => runner.drain(),
      drainWarningMilliseconds,
      () => {
        schedulerLogger.warning(
          "Scheduled worker jobs exceeded the drain warning threshold; " +
            "keeping resources open until they settle.",
          { warningAfterMilliseconds: drainWarningMilliseconds },
        );
      },
    );

  try {
    for (const job of jobs) {
      handles.push(
        cronFactory(
          job,
          () => runner.run(job),
          () => {
            schedulerLogger.warning(
              "Scheduled worker job {jobName} skipped an overlapping tick.",
              { jobName: job.name },
            );
          },
        ),
      );
    }
  } catch (error) {
    stop();
    try {
      await drain();
    } catch (drainError) {
      throw new AggregateError(
        [error, drainError],
        "The worker scheduler failed and its active jobs could not be drained.",
      );
    }
    throw error;
  }

  if (options.signal.aborted) {
    stop();
    await drain();
    return;
  }

  const aborted = new Promise<void>((resolve) => {
    const abort = () => {
      stop();
      resolve();
    };
    options.signal.addEventListener("abort", abort, { once: true });
  });
  await aborted;
  await drain();
}
