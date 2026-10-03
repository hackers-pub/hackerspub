import { normalizeLocale } from "./i18n.ts";
import type { ApplicationContext } from "./context.ts";
import { validateUuid, type Uuid } from "./uuid.ts";

/** Standard Schema's structural contract, without a validator dependency. */
export interface ApplicationTaskSchema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: unknown; readonly output: T };
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: T; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string }[] };
  };
}

/** Stable, versioned names and idempotent schemas are shared by both roles. */
export interface ApplicationTask<T> {
  readonly name: string;
  readonly schema: ApplicationTaskSchema<T>;
}

export interface ApplicationTaskEnqueueOptions {
  readonly delay?: Temporal.DurationLike;
  readonly orderingKey?: string;
}

export interface ApplicationTaskExecution {
  readonly signal: AbortSignal;
  /** Zero-based execution attempt; graceful interruptions do not consume it. */
  readonly attempt: number;
}

/** Await execution and persistence, and pass the signal to cancellable I/O. */
export type ApplicationTaskHandler<T> = (
  context: ApplicationContext,
  data: T,
  execution: ApplicationTaskExecution,
) => Promise<void>;

export interface ApplicationTaskProbePayload {
  readonly jobId: Uuid;
}

export const applicationTaskProbe: ApplicationTask<ApplicationTaskProbePayload> =
  {
    name: "application.probe.v1",
    schema: {
      "~standard": {
        version: 1,
        vendor: "hackerspub",
        validate(value) {
          if (
            typeof value === "object" &&
            value != null &&
            "jobId" in value &&
            validateUuid(value.jobId)
          ) {
            return { value: value as ApplicationTaskProbePayload };
          }
          return { issues: [{ message: "Expected a UUID jobId." }] };
        },
      },
    },
  };

/** Reject codec values that could perform network I/O inside a transaction. */
export function assertApplicationTaskPayload(value: unknown): void {
  const ancestors = new Set<object>();
  function visit(node: unknown): void {
    if (
      node === null ||
      typeof node === "string" ||
      typeof node === "boolean" ||
      (typeof node === "number" && Number.isFinite(node))
    ) {
      return;
    }
    if (
      typeof node !== "object" ||
      ancestors.has(node) ||
      (!Array.isArray(node) &&
        Object.getPrototypeOf(node) !== Object.prototype &&
        Object.getPrototypeOf(node) !== null)
    ) {
      throw new TypeError("Application task payloads must be plain JSON data.");
    }
    ancestors.add(node);
    for (const child of Object.values(node)) visit(child);
    ancestors.delete(node);
  }
  visit(value);
}

export interface ArticleTranslationTaskPayload {
  readonly sourceId: Uuid;
  readonly language: string;
  readonly translationJobToken: Uuid;
}

export interface ArticleTranslationSummaryTaskPayload {
  readonly sourceId: Uuid;
  readonly language: string;
  /** Millisecond-precise claim written atomically with the translated text. */
  readonly claim: string;
}

function validArticleTaskIdentity(
  value: unknown,
): value is { sourceId: Uuid; language: string } {
  return (
    typeof value === "object" &&
    value != null &&
    "sourceId" in value &&
    validateUuid(value.sourceId) &&
    "language" in value &&
    typeof value.language === "string" &&
    normalizeLocale(value.language) != null
  );
}

export const articleTranslationTask: ApplicationTask<ArticleTranslationTaskPayload> =
  {
    name: "article.translation.v1",
    schema: {
      "~standard": {
        version: 1,
        vendor: "hackerspub",
        validate(value) {
          if (
            validArticleTaskIdentity(value) &&
            "translationJobToken" in value &&
            validateUuid(value.translationJobToken)
          ) {
            return { value: value as ArticleTranslationTaskPayload };
          }
          return {
            issues: [
              {
                message: "Expected sourceId, language and translationJobToken.",
              },
            ],
          };
        },
      },
    },
  };

/** Stable wire name retained for messages queued before summary unification. */
export const articleTranslationSummaryTask: ApplicationTask<ArticleTranslationSummaryTaskPayload> =
  {
    name: "article.translation-summary.v1",
    schema: {
      "~standard": {
        version: 1,
        vendor: "hackerspub",
        validate(value) {
          if (
            validArticleTaskIdentity(value) &&
            "claim" in value &&
            typeof value.claim === "string" &&
            Number.isFinite(Date.parse(value.claim)) &&
            new Date(value.claim).toISOString() === value.claim
          ) {
            return { value: value as ArticleTranslationSummaryTaskPayload };
          }
          return {
            issues: [
              {
                message:
                  "Expected sourceId, language and a millisecond ISO claim.",
              },
            ],
          };
        },
      },
    },
  };

/** All summary producers share the existing wire format and registration. */
export const articleSummaryTask = articleTranslationSummaryTask;
export type ArticleSummaryTaskPayload = ArticleTranslationSummaryTaskPayload;

export const SCHEDULED_WORKER_JOB_NAMES = [
  "recompute-news-scores",
  "notify-ended-polls",
  "send-weekly-notification-digests",
  "send-daily-notification-digests",
  "prune-transactional-outbox",
  "prune-article-view-deduplications",
] as const;

export type ScheduledWorkerJobName =
  (typeof SCHEDULED_WORKER_JOB_NAMES)[number];

export interface ScheduledWorkerTaskPayload {
  readonly jobName: ScheduledWorkerJobName;
  /** The original UTC tick, retained across delayed execution and retries. */
  readonly scheduled: string;
}

export const scheduledWorkerTask: ApplicationTask<ScheduledWorkerTaskPayload> =
  {
    name: "scheduled.worker.v1",
    schema: {
      "~standard": {
        version: 1,
        vendor: "hackerspub",
        validate(value) {
          if (
            typeof value === "object" &&
            value != null &&
            "jobName" in value &&
            SCHEDULED_WORKER_JOB_NAMES.some((name) => name === value.jobName) &&
            "scheduled" in value &&
            typeof value.scheduled === "string" &&
            Number.isFinite(Date.parse(value.scheduled)) &&
            new Date(value.scheduled).toISOString() === value.scheduled &&
            new Date(value.scheduled).getUTCSeconds() === 0 &&
            new Date(value.scheduled).getUTCMilliseconds() === 0
          ) {
            return { value: value as ScheduledWorkerTaskPayload };
          }
          return {
            issues: [
              {
                message: "Expected a scheduled job name and a UTC minute tick.",
              },
            ],
          };
        },
      },
    },
  };
