interface FederationQueueRunner<TContextData> {
  startQueue(
    contextData: TContextData,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

type WorkerService = "queue" | "scheduler";

type ServiceCompletion =
  | { readonly service: WorkerService; readonly successful: true }
  | {
      readonly service: WorkerService;
      readonly successful: false;
      readonly error: unknown;
    };

export interface WorkerRuntimeOptions<TContextData> {
  readonly federation: FederationQueueRunner<TContextData>;
  readonly contextData: TContextData;
  readonly runScheduler: (signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function settle(
  service: WorkerService,
  promise: Promise<void>,
): Promise<ServiceCompletion> {
  return promise.then(
    () => ({ service, successful: true }),
    (error: unknown) => ({ service, successful: false, error }),
  );
}

export async function runWorkerRuntime<TContextData>(
  options: WorkerRuntimeOptions<TContextData>,
): Promise<void> {
  const controller = new AbortController();
  let shutdownRequested = options.signal?.aborted ?? false;
  const requestShutdown = () => {
    shutdownRequested = true;
    controller.abort();
  };
  if (options.signal?.aborted) {
    requestShutdown();
  } else {
    options.signal?.addEventListener("abort", requestShutdown, { once: true });
  }

  const queueCompletion = settle(
    "queue",
    options.federation.startQueue(options.contextData, {
      signal: controller.signal,
    }),
  );
  const schedulerCompletion = settle(
    "scheduler",
    Promise.resolve().then(() => options.runScheduler(controller.signal)),
  );

  try {
    const first = await Promise.race([queueCompletion, schedulerCompletion]);
    const externalShutdownRequested = shutdownRequested;
    controller.abort();
    const completions = await Promise.all([
      queueCompletion,
      schedulerCompletion,
    ]);
    const errors: unknown[] = [];

    if (first.successful && !externalShutdownRequested) {
      errors.push(
        new Error(
          `The federation worker ${first.service} stopped unexpectedly.`,
        ),
      );
    }
    for (const completion of completions) {
      if (
        !completion.successful &&
        !(externalShutdownRequested && isAbortError(completion.error))
      ) {
        errors.push(completion.error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "The federation worker failed.");
    }
  } finally {
    options.signal?.removeEventListener("abort", requestShutdown);
  }
}
