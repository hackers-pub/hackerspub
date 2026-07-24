import { query, type RoutePreloadFuncArgs } from "@solidjs/router";
import {
  type CacheConfig,
  type FetchPolicy,
  fetchQuery,
  type FetchQueryFetchPolicy,
  type GraphQLTaggedNode,
  type IEnvironment,
  type OperationType,
  type VariablesOf,
} from "relay-runtime";
import {
  createMemo,
  createSignal,
  getOwner,
  onMount,
  type Owner,
  runWithOwner,
} from "solid-js";
import {
  createPreloadedQuery,
  type DataStore,
  type PreloadedQuery,
  useRelayEnvironment,
} from "solid-relay";

export type MaybePromise<T> = T | Promise<T>;

export interface RelayPreloadOptions {
  fetchPolicy?: FetchPolicy | null | undefined;
  networkCacheConfig?: CacheConfig | null | undefined;
}

export interface RoutePreloadedQuery<
  TLoader extends (...args: never[]) => PreloadedQuery<OperationType>,
> {
  (...args: Parameters<TLoader>): MaybePromise<ReturnType<TLoader>>;
  preload: (...args: Parameters<TLoader>) => void;
  key: string;
  keyFor: (...args: Parameters<TLoader>) => string;
}

function toFetchQueryPolicy(
  fetchPolicy: FetchPolicy | null | undefined,
): FetchQueryFetchPolicy | null {
  switch (fetchPolicy) {
    case "store-only":
      return null;
    case "network-only":
    case "store-and-network":
      return "network-only";
    case "store-or-network":
    case undefined:
    case null:
      return "store-or-network";
  }
}

export function preloadRelayQuery<TQuery extends OperationType>(
  environment: IEnvironment,
  query: GraphQLTaggedNode,
  variables: VariablesOf<TQuery>,
  options?: RelayPreloadOptions,
): void {
  const fetchPolicy = toFetchQueryPolicy(options?.fetchPolicy);
  if (fetchPolicy == null) return;
  fetchQuery<TQuery>(environment, query, variables, {
    fetchPolicy,
    networkCacheConfig: options?.networkCacheConfig,
  }).subscribe({
    error(error: unknown) {
      console.error("Relay query preload failed:", error);
    },
  });
}

export function refreshRelayQuery<TQuery extends OperationType>(
  environment: IEnvironment,
  query: GraphQLTaggedNode,
  variables: VariablesOf<TQuery>,
  options?: Omit<RelayPreloadOptions, "fetchPolicy">,
): Promise<void> {
  return new Promise((resolve, reject) => {
    fetchQuery<TQuery>(environment, query, variables, {
      fetchPolicy: "network-only",
      networkCacheConfig: options?.networkCacheConfig,
    }).subscribe({
      complete() {
        resolve();
      },
      error(error: unknown) {
        reject(error);
      },
    });
  });
}

export function routePreloadedQuery<
  TLoader extends (...args: never[]) => PreloadedQuery<OperationType>,
>(loader: TLoader, name: string): RoutePreloadedQuery<TLoader> {
  const cached = query(loader, name) as unknown as RoutePreloadedQuery<TLoader>;
  const wrapped = ((...args: Parameters<TLoader>) => {
    const key = cached.keyFor(...args);
    const owner = getOwner();
    const currentEnvironment = useRelayEnvironment()();
    const preloaded = cached(...args);
    // query() from @solidjs/router wraps non-preload cache hits with
    // handleResponse(), which is an async function that returns a NEW Promise
    // on every call — even when the PreloadedQuery is already resolved. This
    // new Promise reference makes createResource (inside createPreloadedQuery)
    // see a changed source on every reactive signal update, briefly setting
    // pending = true and causing a visible full-page flash.
    //
    // Calling cached() above runs handleResponse() synchronously (it has no
    // await), which stores the resolved value in cached[2]. query.get(key)
    // reads cached[2] directly, giving us the original PreloadedQuery by
    // reference. Returning that same reference keeps createResource's source
    // stable across navigations — no re-fetch, no flash.
    const resolvedSync = query.get(key) as ReturnType<TLoader> | undefined;
    if (
      resolvedSync != null &&
      !isStalePreloadedQuery(resolvedSync, currentEnvironment)
    ) {
      return resolvedSync;
    }
    if (isPromiseLike(preloaded)) {
      return preloaded.then((resolved) => {
        if (!isStalePreloadedQuery(resolved, currentEnvironment)) {
          return resolved;
        }

        query.delete(key);
        return runCached(owner, cached, args);
      });
    }
    if (!isStalePreloadedQuery(preloaded, currentEnvironment)) {
      return preloaded;
    }

    query.delete(key);
    return runCached(owner, cached, args);
  }) as RoutePreloadedQuery<TLoader>;
  wrapped.preload = (...args: Parameters<TLoader>) => {
    const owner = getOwner();
    try {
      const preloaded = runCached(owner, loader, args);
      if (isPromiseLike(preloaded)) {
        preloaded.then(releaseWhenPreloadSettles).catch((error: unknown) => {
          console.error("Relay query route preload failed:", error);
        });
        return;
      }
      releaseWhenPreloadSettles(preloaded);
    } catch (error) {
      console.error("Relay query route preload failed:", error);
    }
  };
  wrapped.key = cached.key;
  wrapped.keyFor = cached.keyFor;
  return wrapped;
}

export function preloadRouteQuery<
  TLoader extends (...args: never[]) => PreloadedQuery<OperationType>,
>(
  routeArgs: Pick<RoutePreloadFuncArgs, "intent">,
  loader: RoutePreloadedQuery<TLoader>,
  ...args: Parameters<TLoader>
): void {
  if (routeArgs.intent === "preload") {
    loader.preload(...args);
    return;
  }
  void loader(...args);
}

function releaseWhenPreloadSettles(
  preloaded: PreloadedQuery<OperationType> | null | undefined,
): void {
  const controls = preloaded?.controls?.value;
  if (controls == null) return;
  if (controls.source == null) {
    controls.releaseQuery();
    return;
  }
  controls.source.subscribe({
    complete() {
      controls.releaseQuery();
    },
    error(error: unknown) {
      console.error("Relay query route preload failed:", error);
      controls.releaseQuery();
    },
  });
}

function isStalePreloadedQuery(
  preloaded: PreloadedQuery<OperationType> | null | undefined,
  environment: IEnvironment,
): boolean {
  const controls = preloaded?.controls?.value;
  return (
    controls != null &&
    (controls.isDisposed() || controls.environment !== environment)
  );
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === "object" && value != null && "then" in value;
}

function runCached<TLoader extends (...args: never[]) => unknown>(
  owner: Owner | null,
  cached: TLoader,
  args: Parameters<TLoader>,
): ReturnType<TLoader> {
  if (owner == null) return cached(...args) as ReturnType<TLoader>;
  return runWithOwner(owner, () => cached(...args)) as ReturnType<TLoader>;
}

// Like solid-relay's `createPreloadedQuery`, but keeps the `<Show keyed
// when={data()}>` subtree mounted through hydration so a transient
// `null`/`undefined` cannot crash the page.
//
// The flash: solid-relay republishes a query/fragment snapshot inside `batch()`
// (the "stale read from `<Show>`" race), so `data()` momentarily reads falsy. If
// that happens while `isHydrating()` is true, the `Show` unmounts and remounts
// its subtree; the remount re-enters Solid's hydration path with
// hydration-registry nodes that were already consumed, and Kobalte's
// `Polymorphic` (a string-component `Dynamic`) then calls `getNextElement()`
// with no `template` fallback and throws `TypeError: <x> is not a function`.
//
// Fix: hold the last non-null value, but only until `onMount` (i.e. until
// hydration finishes). After that, fall back to the live store value so genuine
// input changes (search, sort, route params) are reflected immediately instead
// of masked by stale data; a remount after hydration is harmless because
// `getNextElement()` is no longer on the path. This also preserves SSR
// streaming, unlike a `!data.pending && data()` guard that short-circuits the
// resource and stops the SSR Suspense boundary from ever suspending.
//
// `.latest` keeps the conventional `DataStore` meaning (the last resolved
// value, even while a refetch is pending); `.pending`/`.error` are delegated to
// the underlying store.
export function createStablePreloadedQuery<TQuery extends OperationType>(
  query: GraphQLTaggedNode,
  preloadedQuery: () => MaybePromise<PreloadedQuery<TQuery> | null | undefined>,
): DataStore<TQuery["response"] | null | undefined> {
  const store = createPreloadedQuery<TQuery>(query, preloadedQuery);
  // Derive from `store.latest` (a non-throwing getter), not `store()` (which
  // rethrows in an error state to propagate to the nearest `ErrorBoundary`), so
  // reading `.latest` never throws.
  const latest = createMemo<TQuery["response"] | null | undefined>(
    (prev) => store.latest ?? prev,
  );
  const [hydrated, setHydrated] = createSignal(false);
  onMount(() => setHydrated(true));
  const current = createMemo<TQuery["response"] | null | undefined>((prev) => {
    const value = store();
    return value != null || hydrated() ? value : prev;
  });
  const accessor = (() => current()) as unknown as DataStore<
    TQuery["response"] | null | undefined
  >;
  Object.defineProperties(accessor, {
    latest: { get: () => latest(), enumerable: true },
    error: { get: () => store.error, enumerable: true },
    pending: { get: () => store.pending, enumerable: true },
  });
  return accessor;
}

// For app-level resources whose subtree should keep rendering while a fresh
// preload is in flight. Unlike `createStablePreloadedQuery`, this keeps the
// last resolved value beyond hydration; use it only for stable chrome providers
// where showing the previous value briefly is better than replacing the whole
// app with the root `<Suspense>` fallback.
export function createPersistentPreloadedQuery<TQuery extends OperationType>(
  query: GraphQLTaggedNode,
  preloadedQuery: () => MaybePromise<PreloadedQuery<TQuery> | null | undefined>,
): DataStore<TQuery["response"] | null | undefined> {
  const store = createPreloadedQuery<TQuery>(query, preloadedQuery);
  const latest = createMemo<TQuery["response"] | null | undefined>(
    (prev) => store.latest ?? prev,
  );
  const current = createMemo<TQuery["response"] | null | undefined>((prev) => {
    const previous = latest() ?? prev;
    if (store.pending && previous != null) return previous;
    const value = store();
    return value ?? previous;
  });
  const accessor = (() => current()) as unknown as DataStore<
    TQuery["response"] | null | undefined
  >;
  Object.defineProperties(accessor, {
    latest: { get: () => latest(), enumerable: true },
    error: { get: () => store.error, enumerable: true },
    pending: {
      get: () => store.pending && latest() == null,
      enumerable: true,
    },
  });
  return accessor;
}
