import {
  getRequestWorkSignal,
  hasRequestWork,
  reportRequestWorkFailure,
  runWithRequestWork,
  throwIfRequestWorkAborted,
  trackRequestWork,
} from "@hackerspub/models/request-work";
import type { Sql } from "postgres";

export interface SqlWorkStats {
  readonly active: number;
  readonly limit: number;
  readonly rejected: number;
  readonly nativeCancellations: number;
}

interface MutableSqlWorkStats {
  active: number;
  limit: number;
  rejected: number;
  nativeCancellations: number;
}

const strictStats = new WeakMap<object, MutableSqlWorkStats>();

/** Only strict clients have a SQL admission budget. */
export function getSqlWorkStats(sql: Sql): SqlWorkStats | undefined {
  const stats = strictStats.get(sql);
  return stats == null ? undefined : { ...stats };
}

/** Track consumed Postgres.js query promises without starting lazy queries. */
export function trackSqlWork<T extends Sql>(
  sql: T,
  options: { readonly strict?: { readonly limit: number } } = {},
): T {
  if (options.strict != null)
    return trackStrictSqlWork(sql, options.strict.limit);
  const wrapped = new WeakMap<object, object>();
  function wrapQuery(value: unknown): unknown {
    if (
      !(value instanceof Promise) ||
      typeof (value as { execute?: unknown }).execute !== "function"
    )
      return value;
    const query = value as Promise<unknown> & Record<string, unknown>;
    if (wrapped.has(query)) return query;
    wrapped.set(query, query);
    let tracked = false;
    let iteratorCursor = false;
    const startTracking = () => {
      if (tracked || iteratorCursor || !hasRequestWork()) return;
      throwIfRequestWorkAborted();
      tracked = true;
      // Bypass the Query.then override: observing the underlying promise must
      // not itself start the lazy query or recursively instrument it.
      const observed = Promise.prototype.then.call(
        query,
        (result: unknown) => result,
      );
      void trackRequestWork(observed).catch(() => {});
      const signal = getRequestWorkSignal();
      if (signal != null && typeof query.cancel === "function") {
        // Postgres.js Query.cancel() discards the Promise returned by its
        // underlying canceller. Observe that Promise as well so a failed
        // cancel connection does not become an unhandled rejection.
        const canceller = query.canceller;
        if (typeof canceller === "function") {
          query.canceller = (...args: unknown[]) => {
            const result: unknown = Reflect.apply(canceller, query, args);
            void Promise.resolve(result).catch(() => {});
            return result;
          };
        }
        const cancel = () => {
          try {
            const result: unknown = Reflect.apply(
              query.cancel as Function,
              query,
              [],
            );
            void Promise.resolve(result).catch(() => {});
          } catch {
            // Cancellation is best effort. The actual query remains tracked.
          }
        };
        signal.addEventListener("abort", cancel, { once: true });
        void observed.then(
          () => signal.removeEventListener("abort", cancel),
          () => signal.removeEventListener("abort", cancel),
        );
        if (signal.aborted) cancel();
      }
    };
    const cursor = query.cursor;
    if (typeof cursor === "function") {
      Object.defineProperty(query, "cursor", {
        configurable: true,
        value: function (...args: unknown[]) {
          const result = Reflect.apply(cursor, query, args);
          // Postgres.js replaces Query.resolve for async-iterator cursors, so
          // the underlying Promise never settles. No guest paths use cursors.
          if (result !== query) iteratorCursor = true;
          return result;
        },
      });
    }
    for (const name of ["then", "catch", "finally", "execute", "forEach"]) {
      const method = query[name];
      if (typeof method !== "function") continue;
      Object.defineProperty(query, name, {
        configurable: true,
        value: function (...args: unknown[]) {
          startTracking();
          return Reflect.apply(method, query, args);
        },
      });
    }
    return query;
  }
  function wrapClient(client: T): T {
    const existing = wrapped.get(client);
    if (existing != null) return existing as T;
    const proxy = new Proxy(client, {
      apply(target, thisArg, args) {
        return wrapQuery(Reflect.apply(target, thisArg, args));
      },
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property === "unsafe" || property === "file") {
          return (...args: unknown[]) =>
            wrapQuery(Reflect.apply(value, target, args));
        }
        if (property === "begin" || property === "savepoint") {
          return (...args: unknown[]) => {
            const last = args.length - 1;
            if (typeof args[last] === "function") {
              const callback = args[last];
              args[last] = (tx: T, ...rest: unknown[]) =>
                callback(wrapClient(tx), ...rest);
            }
            return Reflect.apply(value, target, args);
          };
        }
        if (property === "reserve") {
          return (...args: unknown[]) =>
            (Reflect.apply(value, target, args) as Promise<T>).then(wrapClient);
        }
        return value;
      },
    });
    wrapped.set(client, proxy);
    return proxy;
  }
  return wrapClient(sql);
}

function trackStrictSqlWork<T extends Sql>(sql: T, limit: number): T {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(
      "The protocol SQL work limit must be a positive safe integer.",
    );
  }
  const stats: MutableSqlWorkStats = {
    active: 0,
    limit,
    rejected: 0,
    nativeCancellations: 0,
  };
  const wrapped = new WeakMap<object, object>();
  const startupSignal = new AbortController().signal;

  function acquire(): () => void {
    throwIfRequestWorkAborted();
    if (stats.active >= stats.limit) {
      stats.rejected++;
      const error = new Error("The protocol SQL work limit has been reached.");
      reportRequestWorkFailure({ kind: "overload", error });
      throw error;
    }
    stats.active++;
    return () => {
      stats.active--;
    };
  }

  function reportTimeout(error: unknown): void {
    if (getRequestWorkSignal()?.aborted) return;
    const code =
      error != null && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (code === "57014" || code === "55P03") {
      reportRequestWorkFailure({ kind: "timeout", error });
    }
  }

  function own<R>(promise: Promise<R>, release: () => void): Promise<R> {
    const observed = promise.then(
      (result) => {
        release();
        return result;
      },
      (error: unknown) => {
        release();
        reportTimeout(error);
        throw error;
      },
    );
    // Observe failures even when a caller abandons its transaction or query.
    void trackRequestWork(observed).catch(() => {});
    return observed;
  }

  function unsupported(operation: PropertyKey): never {
    throw new TypeError(
      `Postgres.js ${String(operation)} is unavailable on the protocol SQL client.`,
    );
  }

  function wrapQuery(value: unknown): unknown {
    if (
      !(value instanceof Promise) ||
      typeof (value as { execute?: unknown }).execute !== "function"
    )
      return value;
    const query = value as Promise<unknown> & Record<string, unknown>;
    if (wrapped.has(query)) return query;
    wrapped.set(query, query);
    let tracked = false;
    const startTracking = () => {
      if (tracked) return;
      const release = acquire();
      tracked = true;
      // Observing with Promise.prototype bypasses Query.then's lazy execution.
      const actual = Promise.prototype.then.call(
        query,
        (result: unknown) => result,
        (error: unknown) => {
          // This observer is registered before the caller's rejection handler,
          // so a swallowed SQL timeout cannot write a negative key cache first.
          reportTimeout(error);
          throw error;
        },
      );
      own(actual, release);
    };
    for (const name of ["cancel", "cursor", "readable", "writable"]) {
      Object.defineProperty(query, name, {
        configurable: true,
        value: () => unsupported(name),
      });
    }
    for (const name of ["then", "catch", "finally", "execute", "forEach"]) {
      const method = query[name];
      if (typeof method !== "function") continue;
      Object.defineProperty(query, name, {
        configurable: true,
        value: function (...args: unknown[]) {
          startTracking();
          return Reflect.apply(method, query, args);
        },
      });
    }
    return query;
  }

  function wrapClient(client: T, transaction = false): T {
    const existing = wrapped.get(client);
    if (existing != null) return existing as T;
    const proxy = new Proxy(client, {
      apply(target, thisArg, args) {
        return wrapQuery(Reflect.apply(target, thisArg, args));
      },
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (
          property === "reserve" ||
          property === "listen" ||
          property === "subscribe" ||
          property === "prepare" ||
          property === "largeObject" ||
          (transaction && property === "notify")
        )
          return () => unsupported(property);
        if (property === "unsafe" || property === "file") {
          return (...args: unknown[]) =>
            wrapQuery(Reflect.apply(value, target, args));
        }
        if (property === "begin" || property === "savepoint") {
          return (...args: unknown[]) => {
            const last = args.length - 1;
            if (
              args[0] != null &&
              typeof args[0] === "object" &&
              "raw" in args[0] &&
              Array.isArray(args[0].raw)
            )
              return unsupported(property);
            if (typeof args[last] !== "function") return unsupported(property);
            const callback = args[last];
            const signal = getRequestWorkSignal() ?? startupSignal;
            const children: Promise<unknown>[] = [];
            args[last] = (tx: T, ...rest: unknown[]) => {
              const child = runWithRequestWork(signal, async () => {
                const result = callback(wrapClient(tx, true), ...rest);
                // Native begin/savepoint await an array returned directly by
                // the callback. An async wrapper must preserve that behavior.
                return await (Array.isArray(result)
                  ? Promise.all(result)
                  : result);
              });
              children.push(child);
              return child;
            };
            const release = acquire();
            let native: Promise<unknown>;
            try {
              native = Promise.resolve(Reflect.apply(value, target, args));
            } catch (error) {
              native = Promise.reject(error);
            }
            // Postgres.js races the transaction callback against connection
            // closure. Retain the callback even if that native race rejects.
            const lifecycle = native.finally(async () => {
              await Promise.allSettled(children);
            });
            return own(lifecycle, release);
          };
        }
        if (property === "notify") {
          return (...args: unknown[]) => {
            const release = acquire();
            let promise: Promise<unknown>;
            try {
              promise = Promise.resolve(Reflect.apply(value, target, args));
            } catch (error) {
              promise = Promise.reject(error);
            }
            return own(promise, release);
          };
        }
        return value;
      },
    });
    wrapped.set(client, proxy);
    strictStats.set(proxy, stats);
    return proxy;
  }
  return wrapClient(sql);
}
