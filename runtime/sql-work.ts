import {
  getRequestWorkSignal,
  hasRequestWork,
  throwIfRequestWorkAborted,
  trackRequestWork,
} from "@hackerspub/models/request-work";
import type { Sql } from "postgres";

/** Track consumed Postgres.js query promises without starting lazy queries. */
export function trackSqlWork<T extends Sql>(sql: T): T {
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
