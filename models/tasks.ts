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
