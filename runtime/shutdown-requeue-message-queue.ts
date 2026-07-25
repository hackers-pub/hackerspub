import type {
  MessageQueue,
  MessageQueueDepth,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";

interface WarningLogger {
  warning(message: string, properties: Record<string, unknown>): void;
}

export interface ShutdownRequeueMessageQueueOptions {
  readonly logger?: WarningLogger;
  readonly retryDelayMilliseconds?: number;
}

type HandlerCompletion =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: unknown };

type RequeueCompletion =
  | { readonly status: "requeued" }
  | { readonly status: "requeue-failed"; readonly error: unknown };

type RetryCompletion = { readonly status: "retry" };

type DelegateCompletion =
  | { readonly successful: true }
  | { readonly successful: false; readonly error: unknown };

const logger: WarningLogger = getLogger([
  "hackerspub",
  "runtime",
  "federation",
  "inbox-queue",
]);
const DEFAULT_RETRY_DELAY_MILLISECONDS = 1_000;

/**
 * Re-enqueues an inbox message when shutdown interrupts its handler.
 *
 * Fedify's PostgreSQL queue removes a message before invoking its handler and
 * waits for that handler even after the listener signal is aborted.  This
 * decorator lets the listener stop once the same message is durable again.
 * It is intended for Fedify's inbox queue, whose messages have no ordering
 * keys.
 */
export class ShutdownRequeueMessageQueue implements MessageQueue {
  readonly getDepth?: () => Promise<MessageQueueDepth>;
  readonly #queue: MessageQueue;
  readonly #logger: WarningLogger;
  readonly #retryDelayMilliseconds: number;

  constructor(
    queue: MessageQueue,
    options: ShutdownRequeueMessageQueueOptions = {},
  ) {
    this.#queue = queue;
    this.#logger = options.logger ?? logger;
    this.#retryDelayMilliseconds =
      options.retryDelayMilliseconds ?? DEFAULT_RETRY_DELAY_MILLISECONDS;
    this.getDepth = queue.getDepth?.bind(queue);
  }

  get nativeRetrial(): boolean | undefined {
    return this.#queue.nativeRetrial;
  }

  enqueue(
    message: unknown,
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    return this.#queue.enqueue(message, options);
  }

  async enqueueMany(
    messages: readonly unknown[],
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    if (this.#queue.enqueueMany != null) {
      await this.#queue.enqueueMany(messages, options);
      return;
    }
    await Promise.all(
      messages.map((message) => this.#queue.enqueue(message, options)),
    );
  }

  async listen(
    handler: (message: unknown) => Promise<void> | void,
    options: MessageQueueListenOptions = {},
  ): Promise<void> {
    const activeHandlers = new Set<Promise<void>>();
    const delegateCompletion = await this.#queue
      .listen((message) => {
        const handling = this.#handle(message, handler, options.signal);
        activeHandlers.add(handling);
        void handling.then(
          () => activeHandlers.delete(handling),
          () => activeHandlers.delete(handling),
        );
        return handling;
      }, options)
      .then<DelegateCompletion, DelegateCompletion>(
        () => ({ successful: true }),
        (error: unknown) => ({ successful: false, error }),
      );

    while (activeHandlers.size > 0) {
      await Promise.allSettled(activeHandlers);
    }
    if (!delegateCompletion.successful) throw delegateCompletion.error;
  }

  #delayRetry(): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, this.#retryDelayMilliseconds),
    );
  }

  async #waitForHandlerOrRetry(
    handlerCompletion: Promise<HandlerCompletion>,
  ): Promise<HandlerCompletion | RetryCompletion> {
    const retry = Promise.withResolvers<RetryCompletion>();
    const timeout = setTimeout(
      () => retry.resolve({ status: "retry" }),
      this.#retryDelayMilliseconds,
    );
    try {
      return await Promise.race([handlerCompletion, retry.promise]);
    } finally {
      clearTimeout(timeout);
    }
  }

  #logHandlerFailure(error: unknown): void {
    this.#logger.warning(
      "An inbox handler failed while its message was being made durable " +
        "during shutdown: {error}",
      { error },
    );
  }

  #logRequeueFailure(error: unknown, attempt: number): void {
    this.#logger.warning(
      "Failed to requeue an interrupted inbox message; keeping shutdown " +
        "open and retrying: {error}",
      {
        error,
        attempt,
        retryDelayMilliseconds: this.#retryDelayMilliseconds,
      },
    );
  }

  async #makeDurable(
    message: unknown,
    handlerCompletion?: Promise<HandlerCompletion>,
  ): Promise<void> {
    let handlerResult: HandlerCompletion | undefined;
    let handlerFailureLogged = false;

    for (let attempt = 1; ; attempt++) {
      const requeueCompletion = Promise.resolve()
        .then(() => this.#queue.enqueue(message))
        .then<RequeueCompletion, RequeueCompletion>(
          () => ({ status: "requeued" }),
          (error: unknown) => ({ status: "requeue-failed", error }),
        );
      const first =
        handlerCompletion != null && handlerResult == null
          ? await Promise.race([handlerCompletion, requeueCompletion])
          : await requeueCompletion;

      if (first.status === "completed") return;
      if (first.status === "failed") {
        handlerResult = first;
        if (!handlerFailureLogged) {
          this.#logHandlerFailure(first.error);
          handlerFailureLogged = true;
        }
        const requeue = await requeueCompletion;
        if (requeue.status === "requeued") return;
        this.#logRequeueFailure(requeue.error, attempt);
        await this.#delayRetry();
        continue;
      }
      if (first.status === "requeued") {
        if (handlerCompletion != null && !handlerFailureLogged) {
          void handlerCompletion.then((lateCompletion) => {
            if (lateCompletion.status === "failed") {
              this.#logHandlerFailure(lateCompletion.error);
            }
          });
        }
        return;
      }

      this.#logRequeueFailure(first.error, attempt);
      if (handlerCompletion == null || handlerResult != null) {
        await this.#delayRetry();
        continue;
      }
      const next = await this.#waitForHandlerOrRetry(handlerCompletion);
      if (next.status === "completed") return;
      if (next.status === "failed") {
        handlerResult = next;
        if (!handlerFailureLogged) {
          this.#logHandlerFailure(next.error);
          handlerFailureLogged = true;
        }
        await this.#delayRetry();
      }
    }
  }

  async #handle(
    message: unknown,
    handler: (message: unknown) => Promise<void> | void,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (signal == null) {
      await handler(message);
      return;
    }
    if (signal.aborted) {
      await this.#makeDurable(message);
      return;
    }

    const handlerCompletion: Promise<HandlerCompletion> = Promise.resolve()
      .then(() => handler(message))
      .then<HandlerCompletion, HandlerCompletion>(
        () => ({ status: "completed" }),
        (error: unknown) => ({ status: "failed", error }),
      );
    const shutdown = Promise.withResolvers<{ readonly status: "aborted" }>();
    const handleAbort = () => shutdown.resolve({ status: "aborted" });
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();

    try {
      const completion = await Promise.race([
        handlerCompletion,
        shutdown.promise,
      ]);
      if (completion.status === "completed") return;
      if (completion.status === "failed" && !signal.aborted) {
        throw completion.error;
      }
      await this.#makeDurable(message, handlerCompletion);
    } finally {
      signal.removeEventListener("abort", handleAbort);
    }
  }
}
