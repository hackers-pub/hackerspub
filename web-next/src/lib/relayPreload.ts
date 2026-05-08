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
import type { PreloadedQuery } from "solid-relay";

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
): TLoader & {
  key: string;
  keyFor: (...args: Parameters<TLoader>) => string;
} {
  const cached = query(loader, name) as unknown as TLoader & {
    key: string;
    keyFor: (...args: Parameters<TLoader>) => string;
  };
  const wrapped = ((...args: Parameters<TLoader>) => {
    const preloaded = cached(...args);
    if (!preloaded.controls?.value.isDisposed()) return preloaded;

    const fresh = loader(...args);
    query.set(cached.keyFor(...args), fresh);
    return fresh;
  }) as TLoader & {
    key: string;
    keyFor: (...args: Parameters<TLoader>) => string;
  };
  wrapped.key = cached.key;
  wrapped.keyFor = cached.keyFor;
  return wrapped;
}
