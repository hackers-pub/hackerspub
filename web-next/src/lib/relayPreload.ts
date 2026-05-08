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
import type { PreloadedQuery } from "solid-relay";

type MaybePromise<T> = T | Promise<T>;

export interface RelayPreloadOptions {
  fetchPolicy?: FetchPolicy | null | undefined;
  networkCacheConfig?: CacheConfig | null | undefined;
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
): ((...args: Parameters<TLoader>) => MaybePromise<ReturnType<TLoader>>) & {
  key: string;
  keyFor: (...args: Parameters<TLoader>) => string;
} {
  const cached = query(loader, name) as unknown as
    & ((
      ...args: Parameters<TLoader>
    ) => MaybePromise<ReturnType<TLoader>>)
    & {
      key: string;
      keyFor: (...args: Parameters<TLoader>) => string;
    };
  const wrapped = ((...args: Parameters<TLoader>) => {
    const key = cached.keyFor(...args);
    const cachedValue = getCachedValue(key);
    if (
      cachedValue.exists &&
      cachedValue.value != null &&
      isDisposed(cachedValue.value)
    ) {
      query.delete(key);
    }

    const owner = getOwner();
    const preloaded = cached(...args);
    if (isPromiseLike(preloaded)) {
      return preloaded.then((resolved) => {
        if (!isDisposed(resolved)) return resolved;

        query.delete(key);
        return runLoader(owner, loader, args);
      });
    }
    if (!isDisposed(preloaded)) return preloaded;

    query.delete(key);
    return runLoader(owner, loader, args);
  }) as
    & ((...args: Parameters<TLoader>) => MaybePromise<ReturnType<TLoader>>)
    & {
      key: string;
      keyFor: (...args: Parameters<TLoader>) => string;
    };
  wrapped.key = cached.key;
  wrapped.keyFor = cached.keyFor;
  return wrapped;
}

function isDisposed(preloaded: PreloadedQuery<OperationType>): boolean {
  return preloaded.controls?.value.isDisposed() ?? false;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === "object" && value != null && "then" in value;
}

function getCachedValue(
  key: string,
):
  | { exists: true; value: PreloadedQuery<OperationType> | undefined }
  | { exists: false } {
  try {
    return { exists: true, value: query.get(key) };
  } catch {
    return { exists: false };
  }
}

function runLoader<TLoader extends (...args: never[]) => unknown>(
  owner: Owner | null,
  loader: TLoader,
  args: Parameters<TLoader>,
): ReturnType<TLoader> {
  if (owner == null) return loader(...args) as ReturnType<TLoader>;
  return runWithOwner(owner, () => loader(...args)) as ReturnType<TLoader>;
}
