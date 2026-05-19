import { query } from "@solidjs/router";
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
import { getOwner, type Owner, runWithOwner } from "solid-js";
import { type PreloadedQuery, useRelayEnvironment } from "solid-relay";

export type MaybePromise<T> = T | Promise<T>;

export interface RelayPreloadOptions {
  fetchPolicy?: FetchPolicy | null | undefined;
  networkCacheConfig?: CacheConfig | null | undefined;
}

export interface RoutePreloadedQuery<
  TLoader extends (...args: never[]) => PreloadedQuery<OperationType>,
> {
  (...args: Parameters<TLoader>): MaybePromise<ReturnType<TLoader>>;
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
>(
  loader: TLoader,
  name: string,
): RoutePreloadedQuery<TLoader> {
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
  wrapped.key = cached.key;
  wrapped.keyFor = cached.keyFor;
  return wrapped;
}

function isStalePreloadedQuery(
  preloaded: PreloadedQuery<OperationType> | null | undefined,
  environment: IEnvironment,
): boolean {
  const controls = preloaded?.controls?.value;
  return controls != null &&
    (controls.isDisposed() || controls.environment !== environment);
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
