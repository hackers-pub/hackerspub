import {
  type DocumentLoader,
  type DocumentLoaderFactoryOptions,
  type FederationOptions,
  FetchError,
  getAuthenticatedDocumentLoader,
  getDocumentLoader,
  type HttpMessageSignaturesSpec,
  type KvKey,
  type KvStore,
  kvCache,
} from "@fedify/fedify";
import {
  getRequestWorkOutcome,
  getRequestWorkSignal,
  reportRequestDependencyInterruption,
  reportRequestWorkFailure,
  throwIfRequestWorkAborted,
  trackRequestWork,
} from "@hackerspub/models/request-work";
import { AsyncLocalStorage } from "node:async_hooks";

interface ProtocolLoaderConfig {
  kv: KvStore;
  userAgent?: FederationOptions<unknown>["userAgent"];
  firstKnock?: HttpMessageSignaturesSpec;
  limit: number;
  timeoutMs: number;
}

export interface ProtocolLoaderStats {
  active: number;
  limit: number;
  rejected: number;
  timedOut: number;
}

type ProtocolLoaderOptions = Required<
  Pick<
    FederationOptions<unknown>,
    | "documentLoaderFactory"
    | "contextLoaderFactory"
    | "authenticatedDocumentLoaderFactory"
  >
>;

/** Keep locally interrupted key retrieval from poisoning later HTTP retries. */
export function createProtocolKvStore(
  kv: KvStore,
  publicKeyPrefix: KvKey = ["_fedify", "publicKey"],
): KvStore {
  return new Proxy(kv, {
    get(target, property) {
      if (property === "set") {
        return async (...args: Parameters<KvStore["set"]>) => {
          const [key] = args;
          if (
            publicKeyPrefix.every((segment, index) => key[index] === segment)
          ) {
            const outcome = getRequestWorkOutcome();
            if (
              getRequestWorkSignal()?.aborted ||
              outcome.hardFailure != null ||
              outcome.dependencyInterrupted
            ) {
              return;
            }
          }
          await target.set(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Supported Fedify loaders with one shared, queue-free execution budget. */
export function createProtocolLoaders(config: ProtocolLoaderConfig): {
  options: ProtocolLoaderOptions;
  stats: () => ProtocolLoaderStats;
} {
  if (!Number.isSafeInteger(config.limit) || config.limit <= 0) {
    throw new RangeError("Protocol loader limit must be a positive integer");
  }
  if (
    !Number.isFinite(config.timeoutMs) ||
    config.timeoutMs <= 0 ||
    config.timeoutMs > 2_147_483_647
  ) {
    throw new RangeError(
      "Protocol loader timeout must be a positive timer duration",
    );
  }
  let active = 0;
  let rejected = 0;
  let timedOut = 0;

  function factoryOptions(
    options?: DocumentLoaderFactoryOptions,
  ): DocumentLoaderFactoryOptions {
    const configured = config.userAgent;
    const generated = options?.userAgent;
    return {
      ...options,
      userAgent:
        typeof generated === "string"
          ? generated
          : typeof configured === "string"
            ? configured
            : { ...configured, ...generated },
      // The built-in timeout races the raw operation.  This wrapper owns the
      // full operation, including cache and HTTP session cleanup, instead.
      timeout: null,
    };
  }

  function bounded(loader: DocumentLoader): DocumentLoader {
    return (url, options) => {
      try {
        throwIfRequestWorkAborted();
        if (options?.signal?.aborted) {
          reportRequestDependencyInterruption(options.signal.reason);
          options.signal.throwIfAborted();
        }
        if (active >= config.limit) {
          rejected++;
          const error = new Error(
            "Protocol document loader capacity exhausted",
          );
          reportRequestWorkFailure({ kind: "overload", error });
          throw error;
        }
      } catch (error) {
        return Promise.reject(error);
      }
      active++;
      const scopeSignal = getRequestWorkSignal();
      const local = new AbortController();
      const callerSignal = options?.signal;
      const callerAborted = AsyncLocalStorage.bind(() => {
        if (getRequestWorkOutcome().hardFailure == null) {
          reportRequestDependencyInterruption(callerSignal?.reason);
        }
      });
      callerSignal?.addEventListener("abort", callerAborted, { once: true });
      const signals = [local.signal];
      if (scopeSignal != null) signals.push(scopeSignal);
      if (callerSignal != null) signals.push(callerSignal);
      const signal = AbortSignal.any(signals);
      const timer = setTimeout(() => {
        timedOut++;
        const error = new FetchError(url, "Protocol document loader timed out");
        error.cause = new DOMException(
          "Document loader timed out",
          "TimeoutError",
        );
        reportRequestDependencyInterruption(error);
        local.abort(error);
      }, Math.ceil(config.timeoutMs));
      const operation = (async () => {
        try {
          signal.throwIfAborted();
          const result = await loader(url, { ...options, signal });
          signal.throwIfAborted();
          return result;
        } catch (error) {
          // A loader/cache may ignore cancellation and later fail differently.
          // Preserve the actual interruption after its raw operation settles.
          signal.throwIfAborted();
          throw error;
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener("abort", callerAborted);
          active--;
        }
      })();
      return trackRequestWork(operation);
    };
  }

  const specDeterminer = {
    async determineSpec(origin: string): Promise<HttpMessageSignaturesSpec> {
      return (
        (await config.kv.get<HttpMessageSignaturesSpec>([
          "_fedify",
          "httpMessageSignaturesSpec",
          origin,
        ])) ??
        config.firstKnock ??
        "rfc9421"
      );
    },
    async rememberSpec(origin: string, spec: HttpMessageSignaturesSpec) {
      await config.kv.set(
        ["_fedify", "httpMessageSignaturesSpec", origin],
        spec,
        {
          ttl: Temporal.Duration.from({ days: 90 }),
        },
      );
    },
  };

  const cached = (
    kind: "object" | "context",
    options?: DocumentLoaderFactoryOptions,
  ) =>
    bounded(
      kvCache({
        loader: getDocumentLoader(factoryOptions(options)),
        kv: config.kv,
        kind,
      }),
    );
  return {
    options: {
      documentLoaderFactory: (options) => cached("object", options),
      contextLoaderFactory: (options) => cached("context", options),
      authenticatedDocumentLoaderFactory: (identity, options) =>
        bounded(
          getAuthenticatedDocumentLoader(identity, {
            ...factoryOptions(options),
            specDeterminer,
          }),
        ),
    },
    stats: () => ({ active, limit: config.limit, rejected, timedOut }),
  };
}
