import assert from "node:assert/strict";
import test from "node:test";
import type {
  MessageQueue,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
import { ShutdownRequeueMessageQueue } from "./shutdown-requeue-message-queue.ts";

class TestMessageQueue implements MessageQueue {
  readonly message = { type: "inbox", id: "message-id" };
  readonly enqueued: unknown[] = [];
  readonly listening = Promise.withResolvers<void>();
  readonly enqueueBehaviors: Array<() => Promise<void>> = [];

  async enqueue(
    message: unknown,
    _options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    await this.enqueueBehaviors.shift()?.();
    this.enqueued.push(message);
  }

  async listen(
    handler: (message: unknown) => Promise<void> | void,
    options: MessageQueueListenOptions = {},
  ): Promise<void> {
    this.listening.resolve();
    const handling = Promise.resolve(handler(this.message));
    if (options.signal == null) {
      await handling;
      return;
    }
    const aborted = new Promise<"aborted">((resolve) => {
      options.signal?.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      });
    });
    const first = await Promise.race([
      handling.then<"handled", "handled">(
        () => "handled",
        () => "handled",
      ),
      aborted,
    ]);
    if (first === "handled") {
      await handling;
    } else {
      void handling.catch(() => undefined);
    }
  }
}

test("active inbox messages are requeued before shutdown completes", async () => {
  const delegate = new TestMessageQueue();
  const queue = new ShutdownRequeueMessageQueue(delegate);
  const controller = new AbortController();
  const handlerStarted = Promise.withResolvers<void>();
  const handlerCompletion = Promise.withResolvers<void>();
  const listening = queue.listen(
    async () => {
      handlerStarted.resolve();
      await handlerCompletion.promise;
    },
    { signal: controller.signal },
  );
  await Promise.all([delegate.listening.promise, handlerStarted.promise]);

  controller.abort();
  await listening;

  assert.deepEqual(delegate.enqueued, [delegate.message]);
  handlerCompletion.resolve();
});

test("completed inbox messages are not requeued", async () => {
  const delegate = new TestMessageQueue();
  const queue = new ShutdownRequeueMessageQueue(delegate);
  const controller = new AbortController();

  await queue.listen(() => Promise.resolve(), { signal: controller.signal });

  assert.deepEqual(delegate.enqueued, []);
});

test("late handler failures after requeue are contained and logged", async () => {
  const delegate = new TestMessageQueue();
  const warnings: Array<Record<string, unknown>> = [];
  const queue = new ShutdownRequeueMessageQueue(delegate, {
    logger: {
      warning(_message, properties) {
        warnings.push(properties);
      },
    },
  });
  const controller = new AbortController();
  const handlerStarted = Promise.withResolvers<void>();
  const handlerCompletion = Promise.withResolvers<void>();
  const listening = queue.listen(
    async () => {
      handlerStarted.resolve();
      await handlerCompletion.promise;
    },
    { signal: controller.signal },
  );
  await handlerStarted.promise;

  controller.abort();
  await listening;
  const failure = new Error("handler failed during shutdown");
  handlerCompletion.reject(failure);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(warnings.length, 1);
  assert.strictEqual(warnings[0].error, failure);
});

test("failed shutdown requeues keep the listener open until retry succeeds", async () => {
  const delegate = new TestMessageQueue();
  const firstRequeue = new Error("database disconnected");
  const secondAttempted = Promise.withResolvers<void>();
  const secondRequeue = Promise.withResolvers<void>();
  delegate.enqueueBehaviors.push(
    () => Promise.reject(firstRequeue),
    () => {
      secondAttempted.resolve();
      return secondRequeue.promise;
    },
  );
  const warnings: Array<Record<string, unknown>> = [];
  const queue = new ShutdownRequeueMessageQueue(delegate, {
    logger: {
      warning(_message, properties) {
        warnings.push(properties);
      },
    },
    retryDelayMilliseconds: 0,
  });
  const controller = new AbortController();
  const handlerStarted = Promise.withResolvers<void>();
  const handlerCompletion = Promise.withResolvers<void>();
  const listening = queue.listen(
    async () => {
      handlerStarted.resolve();
      await handlerCompletion.promise;
    },
    { signal: controller.signal },
  );
  await handlerStarted.promise;

  controller.abort();
  handlerCompletion.reject(new Error("handler interrupted"));
  await secondAttempted.promise;
  let listenerStopped = false;
  const observed = listening.then(() => {
    listenerStopped = true;
  });
  await Promise.resolve();
  assert.equal(listenerStopped, false);

  secondRequeue.resolve();
  await observed;
  assert.deepEqual(delegate.enqueued, [delegate.message]);
  assert(
    warnings.some((properties) => properties.error === firstRequeue),
    "the failed requeue should be logged",
  );
});

test("failed shutdown requeues remain paced after the handler fails", async () => {
  const delegate = new TestMessageQueue();
  const secondAttempted = Promise.withResolvers<void>();
  const thirdAttempted = Promise.withResolvers<void>();
  const thirdRequeue = Promise.withResolvers<void>();
  delegate.enqueueBehaviors.push(
    () => Promise.reject(new Error("first requeue failed")),
    () => {
      secondAttempted.resolve();
      return Promise.reject(new Error("second requeue failed"));
    },
    () => {
      thirdAttempted.resolve();
      return thirdRequeue.promise;
    },
  );
  const queue = new ShutdownRequeueMessageQueue(delegate, {
    logger: { warning() {} },
    retryDelayMilliseconds: 50,
  });
  const controller = new AbortController();
  const handlerStarted = Promise.withResolvers<void>();
  const handlerCompletion = Promise.withResolvers<void>();
  const listening = queue.listen(
    async () => {
      handlerStarted.resolve();
      await handlerCompletion.promise;
    },
    { signal: controller.signal },
  );
  await handlerStarted.promise;

  controller.abort();
  handlerCompletion.reject(new Error("handler interrupted"));
  await secondAttempted.promise;
  let thirdStarted = false;
  void thirdAttempted.promise.then(() => {
    thirdStarted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(thirdStarted, false);

  await thirdAttempted.promise;
  thirdRequeue.resolve();
  await listening;
});

test("original handler success makes a failed shutdown requeue safe", async () => {
  const delegate = new TestMessageQueue();
  delegate.enqueueBehaviors.push(() =>
    Promise.reject(new Error("database disconnected")),
  );
  const queue = new ShutdownRequeueMessageQueue(delegate, {
    retryDelayMilliseconds: 1_000,
  });
  const controller = new AbortController();
  const handlerStarted = Promise.withResolvers<void>();
  const handlerCompletion = Promise.withResolvers<void>();
  const listening = queue.listen(
    async () => {
      handlerStarted.resolve();
      await handlerCompletion.promise;
    },
    { signal: controller.signal },
  );
  await handlerStarted.promise;

  controller.abort();
  handlerCompletion.resolve();
  await listening;

  assert.deepEqual(delegate.enqueued, []);
  assert.equal(delegate.enqueueBehaviors.length, 0);
});

test("listener drains every active handler after one fails", async () => {
  const firstMessage = { id: "first" };
  const secondMessage = { id: "second" };
  const handlersStarted = Promise.withResolvers<void>();
  const firstCompletion = Promise.withResolvers<void>();
  const secondCompletion = Promise.withResolvers<void>();
  let started = 0;
  const delegate: MessageQueue = {
    enqueue: () => Promise.resolve(),
    async listen(handler) {
      const first = Promise.resolve(handler(firstMessage));
      const second = Promise.resolve(handler(secondMessage));
      void first.catch(() => undefined);
      void second.catch(() => undefined);
    },
  };
  const queue = new ShutdownRequeueMessageQueue(delegate);
  const failure = new Error("first handler failed");
  const listening = queue.listen(async (message) => {
    started++;
    if (started === 2) handlersStarted.resolve();
    if (message === firstMessage) {
      await firstCompletion.promise;
      throw failure;
    }
    await secondCompletion.promise;
  });
  let listenerSettled = false;
  let listenerError: unknown;
  const observed = listening.then(
    () => {
      listenerSettled = true;
    },
    (error: unknown) => {
      listenerSettled = true;
      listenerError = error;
    },
  );
  await handlersStarted.promise;

  firstCompletion.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(listenerSettled, false);

  secondCompletion.resolve();
  await observed;
  assert.equal(listenerError, undefined);
});
