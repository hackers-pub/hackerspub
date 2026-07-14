import { AsyncLocalStorage } from "node:async_hooks";
import type {
  MessageQueue,
  MessageQueueDepth,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { runInTransaction } from "@hackerspub/models/db";
import {
  type ClaimedOutboxEvent,
  claimOutboxEvent,
  completeOutboxEvent,
  enqueueOutboxEvents,
  failOutboxEvent,
  getOutboxDepth,
  type OutboxDatabase,
  type OutboxEventType,
  renewOutboxLease,
  retryOutboxEvent,
} from "@hackerspub/models/outbox";
import type { OutboxEventError } from "@hackerspub/models/schema";

const logger = getLogger(["hackerspub", "federation", "transactional-outbox"]);

interface ProcessingContext {
  readonly event: ClaimedOutboxEvent;
  // Reserved synchronously before each insert awaits, because Fedify fanout
  // enqueues ordered inbox deliveries in parallel.
  nextPosition: number;
  requeued: boolean;
  deliveryError?: OutboxEventError;
}

interface OutboxContext {
  readonly db: OutboxDatabase;
  readonly pending: Promise<void>[];
  readonly processing?: ProcessingContext;
}

const contextStorage = new AsyncLocalStorage<OutboxContext>();

export function getCurrentOutboxDatabase(): OutboxDatabase | undefined {
  return contextStorage.getStore()?.db;
}

export async function runWithOutboxContext<T>(
  db: OutboxDatabase,
  callback: () => Promise<T>,
): Promise<T> {
  const parent = contextStorage.getStore();
  if (parent?.db === db && parent.processing == null) return await callback();
  const context: OutboxContext = { db, pending: [] };
  return await contextStorage.run(context, async () => {
    const result = await callback();
    await Promise.all(context.pending);
    return result;
  });
}

export function serializeOutboxError(error: unknown): OutboxEventError {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {};
    const errorProperties = error as unknown as Record<string, unknown>;
    for (const property of ["statusCode", "inbox", "activityId"] as const) {
      if (property in error) details[property] = errorProperties[property];
    }
    return {
      name: error.name,
      message: error.message,
      ...(error.stack == null ? {} : { stack: error.stack }),
      ...(Object.keys(details).length === 0 ? {} : { details }),
    };
  }
  return { name: "Error", message: String(error) };
}

export function recordOutboxDeliveryError(error: unknown): void {
  const processing = contextStorage.getStore()?.processing;
  if (processing == null) {
    logger.warning(
      "Observed an outbox delivery error outside a transactional outbox worker: {error}",
      { error },
    );
    return;
  }
  processing.deliveryError = serializeOutboxError(error);
}

interface QueueMessage {
  readonly type: "fanout" | "outbox";
  readonly id: string;
  readonly activityId?: string;
  readonly activityType?: string;
  readonly inbox?: string;
  readonly [key: string]: unknown;
}

export interface TransactionalOutboxQueueOptions {
  readonly now?: () => Date;
  readonly pollInterval?: Temporal.Duration | Temporal.DurationLike;
  readonly leaseDuration?: Temporal.Duration | Temporal.DurationLike;
  readonly heartbeatInterval?: Temporal.Duration | Temporal.DurationLike;
  readonly handlerTimeout?: Temporal.Duration | Temporal.DurationLike;
  readonly maximumProcessingAttempts?: number;
}

export class OutboxHandlerTimeoutError extends Error {
  constructor(readonly timeoutMilliseconds: number) {
    super(`The outbox handler exceeded ${timeoutMilliseconds} milliseconds.`);
    this.name = "OutboxHandlerTimeoutError";
  }
}

class RecordedOutboxDeliveryError extends Error {
  constructor(readonly outboxError: OutboxEventError) {
    super(outboxError.message);
    this.name = outboxError.name;
  }
}

function durationMilliseconds(
  value: Temporal.Duration | Temporal.DurationLike,
): number {
  return Temporal.Duration.from(value).total("milliseconds");
}

function expectedMessageType(eventType: OutboxEventType): QueueMessage["type"] {
  return eventType === "activitypub.fanout" ? "fanout" : "outbox";
}

function validateMessage(
  eventType: OutboxEventType,
  value: unknown,
): QueueMessage {
  if (
    typeof value !== "object" || value == null ||
    !("type" in value) || !("id" in value) ||
    value.type !== expectedMessageType(eventType) ||
    typeof value.id !== "string"
  ) {
    throw new TypeError(
      `Invalid ${eventType} queue message: expected a ${
        expectedMessageType(eventType)
      } message with a string id.`,
    );
  }
  return value as QueueMessage;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted || milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The outbox listener was aborted.", "AbortError");
}

async function runHandlerBounded<T>(
  handler: () => Promise<T> | T,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw getAbortError(signal);
  const interrupted = Promise.withResolvers<never>();
  const timeout = setTimeout(
    () =>
      interrupted.reject(
        new OutboxHandlerTimeoutError(timeoutMilliseconds),
      ),
    timeoutMilliseconds,
  );
  const abort = () => {
    // Give a handler that synchronously triggered shutdown a chance to settle
    // successfully before treating the same signal as an interruption.
    queueMicrotask(() => {
      if (signal?.aborted) interrupted.reject(getAbortError(signal));
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(handler),
      interrupted.promise,
    ]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export class TransactionalOutboxQueue implements MessageQueue {
  readonly nativeRetrial = false;
  readonly #db: OutboxDatabase;
  readonly #eventType: OutboxEventType;
  readonly #now: () => Date;
  readonly #pollIntervalMilliseconds: number;
  readonly #leaseDuration: Temporal.Duration;
  readonly #heartbeatIntervalMilliseconds: number;
  readonly #handlerTimeoutMilliseconds: number;
  readonly #maximumProcessingAttempts: number;

  constructor(
    db: OutboxDatabase,
    eventType: OutboxEventType,
    options: TransactionalOutboxQueueOptions = {},
  ) {
    this.#db = db;
    this.#eventType = eventType;
    this.#now = options.now ?? (() => new Date());
    this.#pollIntervalMilliseconds = durationMilliseconds(
      options.pollInterval ?? { seconds: 5 },
    );
    this.#leaseDuration = Temporal.Duration.from(
      options.leaseDuration ?? { seconds: 180 },
    );
    this.#heartbeatIntervalMilliseconds = durationMilliseconds(
      options.heartbeatInterval ?? { seconds: 60 },
    );
    this.#handlerTimeoutMilliseconds = durationMilliseconds(
      options.handlerTimeout ?? { seconds: 180 },
    );
    this.#maximumProcessingAttempts = options.maximumProcessingAttempts ?? 10;
  }

  enqueue(
    message: unknown,
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    const promise = this.#enqueue(message, options);
    contextStorage.getStore()?.pending.push(promise);
    return promise;
  }

  enqueueMany(
    messages: readonly unknown[],
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    const promise = this.#enqueueMany(messages, options);
    contextStorage.getStore()?.pending.push(promise);
    return promise;
  }

  async #enqueue(
    value: unknown,
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    const message = validateMessage(this.#eventType, value);
    const context = contextStorage.getStore();
    const processing = context?.processing;
    const now = this.#now();
    const available = new Date(
      now.getTime() + durationMilliseconds(options?.delay ?? { seconds: 0 }),
    );

    if (
      processing != null &&
      processing.event.eventType === this.#eventType &&
      processing.event.messageId === message.id
    ) {
      if (
        processing.event.processingAttempts >=
          this.#maximumProcessingAttempts
      ) {
        const error = processing.deliveryError ?? {
          name: "OutboxRetryLimit",
          message: "The queue handler exhausted its delivery attempts.",
        };
        const failed = await failOutboxEvent(
          context!.db,
          processing.event,
          error,
          now,
        );
        if (!failed) throw new Error("The leased outbox event was lost.");
        processing.requeued = true;
        logger.error("Outbox event {eventId} exhausted its retry limit.", {
          eventId: processing.event.id,
          eventType: processing.event.eventType,
          payloadVersion: processing.event.payloadVersion,
          processingAttempts: processing.event.processingAttempts,
          error,
        });
        return;
      }
      const updated = await retryOutboxEvent(
        context!.db,
        processing.event,
        {
          payload: message,
          available,
          error: processing.deliveryError ?? {
            name: "OutboxRetry",
            message: "The queue handler requested another attempt.",
          },
        },
        now,
      );
      if (!updated) throw new Error("The leased outbox event was lost.");
      processing.requeued = true;
      logger.warning(
        "Scheduled outbox event {eventId} for another delivery attempt.",
        {
          eventId: processing.event.id,
          eventType: processing.event.eventType,
          payloadVersion: processing.event.payloadVersion,
          processingAttempts: processing.event.processingAttempts,
          available,
          error: processing.deliveryError,
        },
      );
      return;
    }

    await enqueueOutboxEvents(
      context?.db ?? this.#db,
      [{
        eventType: this.#eventType,
        payloadVersion: 1,
        messageId: message.id,
        payload: message,
        activityId: typeof message.activityId === "string"
          ? message.activityId
          : undefined,
        activityType: typeof message.activityType === "string"
          ? message.activityType
          : undefined,
        inbox: typeof message.inbox === "string" ? message.inbox : undefined,
      }],
      {
        orderingKey: options?.orderingKey,
        now,
        available,
        ...(processing == null ? {} : {
          groupId: processing.event.groupId,
          sequence: processing.event.sequence,
          position: processing.nextPosition++,
        }),
      },
    );
    logger.debug("Enqueued {eventType} message {messageId}.", {
      eventType: this.#eventType,
      messageId: message.id,
      payloadVersion: 1,
      available,
    });
  }

  async #enqueueMany(
    values: readonly unknown[],
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    if (values.length === 0) return;
    const messages = values.map((value) =>
      validateMessage(this.#eventType, value)
    );
    const context = contextStorage.getStore();
    const processing = context?.processing;
    const now = this.#now();
    const available = new Date(
      now.getTime() + durationMilliseconds(options?.delay ?? { seconds: 0 }),
    );
    const position = processing?.nextPosition;
    if (processing != null) processing.nextPosition += messages.length;
    await enqueueOutboxEvents(
      context?.db ?? this.#db,
      messages.map((message) => ({
        eventType: this.#eventType,
        payloadVersion: 1,
        messageId: message.id,
        payload: message,
        activityId: typeof message.activityId === "string"
          ? message.activityId
          : undefined,
        activityType: typeof message.activityType === "string"
          ? message.activityType
          : undefined,
        inbox: typeof message.inbox === "string" ? message.inbox : undefined,
      })),
      {
        orderingKey: options?.orderingKey,
        now,
        available,
        ...(processing == null ? {} : {
          groupId: processing.event.groupId,
          sequence: processing.event.sequence,
          position,
        }),
      },
    );
    logger.debug("Enqueued {messageCount} {eventType} messages.", {
      eventType: this.#eventType,
      messageCount: messages.length,
      payloadVersion: 1,
      available,
    });
  }

  async getDepth(): Promise<MessageQueueDepth> {
    return await getOutboxDepth(this.#db, this.#eventType, this.#now());
  }

  async listen(
    handler: (message: unknown) => Promise<void> | void,
    options: MessageQueueListenOptions = {},
  ): Promise<void> {
    const { signal } = options;
    while (!signal?.aborted) {
      try {
        const event = await claimOutboxEvent(this.#db, this.#eventType, {
          now: this.#now(),
          leaseDuration: this.#leaseDuration,
        });
        if (event == null) {
          await abortableDelay(this.#pollIntervalMilliseconds, signal);
          continue;
        }
        logger.debug("Claimed outbox event {eventId}.", {
          eventId: event.id,
          eventType: event.eventType,
          payloadVersion: event.payloadVersion,
          processingAttempts: event.processingAttempts,
        });
        await this.#process(event, handler, signal);
      } catch (error) {
        logger.error("Failed to poll the transactional outbox: {error}", {
          eventType: this.#eventType,
          error,
        });
        await abortableDelay(this.#pollIntervalMilliseconds, signal);
      }
    }
  }

  async #process(
    event: ClaimedOutboxEvent,
    handler: (message: unknown) => Promise<void> | void,
    signal?: AbortSignal,
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      void renewOutboxLease(this.#db, event, this.#now()).catch((error) => {
        logger.error("Failed to renew outbox lease {eventId}: {error}", {
          eventId: event.id,
          error,
        });
      });
    }, this.#heartbeatIntervalMilliseconds);

    const processWithDatabase = async (db: OutboxDatabase) => {
      const processing: ProcessingContext = {
        event,
        nextPosition: 0,
        requeued: false,
      };
      const context: OutboxContext = { db, pending: [], processing };
      if (event.payloadVersion !== 1) {
        throw new TypeError(
          `Unsupported ${event.eventType} payload version ${event.payloadVersion}.`,
        );
      }
      validateMessage(this.#eventType, event.payload);
      await contextStorage.run(context, async () => {
        await runHandlerBounded(
          () => handler(event.payload),
          this.#handlerTimeoutMilliseconds,
          signal,
        );
        await Promise.all(context.pending);
      });
      if (processing.requeued) return;
      if (processing.deliveryError != null) {
        throw new RecordedOutboxDeliveryError(processing.deliveryError);
      }
      const completed = await completeOutboxEvent(db, event, this.#now());
      logger.debug("Completed outbox event {eventId}.", {
        eventId: event.id,
        eventType: event.eventType,
        payloadVersion: event.payloadVersion,
        processingAttempts: event.processingAttempts,
        staleLease: !completed,
      });
    };

    try {
      if (this.#eventType === "activitypub.fanout") {
        await runInTransaction(this.#db, processWithDatabase);
      } else {
        await processWithDatabase(this.#db);
      }
    } catch (error) {
      const serialized = error instanceof RecordedOutboxDeliveryError
        ? error.outboxError
        : serializeOutboxError(error);
      const invalidPayload = error instanceof TypeError &&
        (event.payloadVersion !== 1 ||
          error.message.startsWith(`Invalid ${event.eventType}`));
      if (
        error instanceof RecordedOutboxDeliveryError ||
        invalidPayload ||
        event.processingAttempts >= this.#maximumProcessingAttempts
      ) {
        const failed = await failOutboxEvent(
          this.#db,
          event,
          serialized,
          this.#now(),
        );
        logger.error("Outbox event {eventId} failed permanently.", {
          eventId: event.id,
          eventType: event.eventType,
          payloadVersion: event.payloadVersion,
          processingAttempts: event.processingAttempts,
          staleLease: !failed,
          error: serialized,
        });
        return;
      }
      const delaySeconds = Math.min(
        300,
        5 * 2 ** Math.max(0, event.processingAttempts - 1),
      );
      const available = new Date(
        this.#now().getTime() + delaySeconds * 1000,
      );
      const retried = await retryOutboxEvent(this.#db, event, {
        payload: event.payload,
        available,
        error: serialized,
      }, this.#now());
      logger.error("Outbox event {eventId} will be retried.", {
        eventId: event.id,
        eventType: event.eventType,
        payloadVersion: event.payloadVersion,
        processingAttempts: event.processingAttempts,
        available,
        staleLease: !retried,
        error: serialized,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
