import type { KvStore, KvStoreListEntry } from "@fedify/fedify";
import { RedisKvStore } from "@fedify/redis";
import {
  reportRequestDependencyInterruption,
  throwIfRequestWorkAborted,
  trackRequestWork,
} from "@hackerspub/models/request-work";
import { Redis } from "ioredis";

/** Protocol-only Redis ownership: a deadline closes the socket, not just a race. */
export function createBoundedRedisKvStore(
  url: URL,
  timeoutMs: number,
): { kv: KvStore; close(): Promise<void> } {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600_000
  ) {
    throw new RangeError("Protocol Redis timeout must be from 1 to 600000 ms");
  }
  let closed = false;
  let current: ReturnType<typeof connect> | undefined;
  function connect() {
    const redis = new Redis(url.href, {
      family: url.hostname.endsWith(".upstash.io") ? 6 : 4,
      lazyConnect: true,
      connectTimeout: timeoutMs,
      disconnectTimeout: 0,
      retryStrategy: () => null,
      reconnectOnError: null,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
    });
    // Errors are returned by the owned command; do not emit an unhandled event.
    redis.on("error", () => {});
    const ended = new Promise<void>((resolve) => redis.once("end", resolve));
    return { redis, ended, kv: new RedisKvStore(redis), stopping: false };
  }
  function stop(client: ReturnType<typeof connect>): Promise<void> {
    if (!client.stopping && client.redis.status !== "end") {
      client.stopping = true;
      // ioredis destroys the underlying stream after disconnectTimeout and
      // rejects its actual pending commands on close. Never replay uncertain writes.
      client.redis.disconnect();
    }
    return client.ended;
  }
  function execute<T>(operation: (kv: KvStore) => Promise<T>): Promise<T> {
    return trackRequestWork(
      (async () => {
        throwIfRequestWorkAborted();
        if (closed) throw new Error("Protocol Redis store is closed");
        // A fresh request may reconnect after a failed generation has fully ended.
        // Commands already sent on that generation are never retried.
        if (current?.stopping) await current.ended;
        throwIfRequestWorkAborted();
        if (closed) throw new Error("Protocol Redis store is closed");
        if (current == null || current.redis.status === "end")
          current = connect();
        const client = current;
        let timeout: DOMException | undefined;
        const timer = setTimeout(() => {
          timeout = new DOMException(
            "Protocol Redis operation timed out",
            "TimeoutError",
          );
          reportRequestDependencyInterruption(timeout);
          void stop(client);
        }, timeoutMs);
        try {
          const result = await operation(client.kv);
          if (timeout != null) throw timeout;
          return result;
        } catch (error) {
          reportRequestDependencyInterruption(error);
          throw timeout ?? error;
        } finally {
          clearTimeout(timer);
          // Keep loader/request ownership until the timed-out socket has closed,
          // including when another concurrent command stopped this generation.
          if (client.stopping || client.redis.status === "end")
            await client.ended;
        }
      })(),
    );
  }
  return {
    kv: {
      get: (key) => execute((kv) => kv.get(key)),
      set: (key, value, options) =>
        execute((kv) => kv.set(key, value, options)),
      delete: (key) => execute((kv) => kv.delete(key)),
      // Bound each iterator step, including any SCAN/GET commands it needs,
      // and retain its original adapter across the iteration.
      async *list(prefix) {
        let iterator: AsyncIterator<KvStoreListEntry> | undefined;
        while (true) {
          const next = await execute((kv) => {
            iterator ??= kv.list(prefix)[Symbol.asyncIterator]();
            return iterator.next();
          });
          if (next.done) return;
          yield next.value;
        }
      },
    },
    async close() {
      closed = true;
      if (current != null) await stop(current);
    },
  };
}
