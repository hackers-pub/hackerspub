import {
  type GraphQLCancellationSource,
  GraphQLRequestCancelledError,
} from "./graphQLCancellation.ts";

export interface GraphQLRequestLifetimeOptions {
  readonly deadline: number;
  readonly timeoutMessage: string;
  readonly requestSignal?: AbortSignal;
  readonly operationSignal?: AbortSignal;
}

export interface GraphQLRequestLifetime {
  readonly signal: AbortSignal;
  check(): void;
  normalizeError(error: unknown): unknown;
  dispose(): void;
}

/** Own the total request budget, including consumption of the response body. */
export function createGraphQLRequestLifetime(
  options: GraphQLRequestLifetimeOptions,
): GraphQLRequestLifetime {
  const controller = new AbortController();
  const listeners: { signal: AbortSignal; listener: () => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expire = () => {
    const error = new Error(options.timeoutMessage);
    error.name = "TimeoutError";
    controller.abort(error);
  };

  const follow = (
    signal: AbortSignal | undefined,
    source: GraphQLCancellationSource,
  ) => {
    if (signal == null || controller.signal.aborted) return;
    const listener = () => {
      controller.abort(new GraphQLRequestCancelledError(source, signal.reason));
    };
    if (signal.aborted) {
      listener();
    } else {
      signal.addEventListener("abort", listener, { once: true });
      listeners.push({ signal, listener });
    }
  };
  follow(options.requestSignal, "inbound");
  follow(options.operationSignal, "disposal");

  if (!controller.signal.aborted) {
    const remaining = options.deadline - performance.now();
    if (remaining <= 0) expire();
    else timer = setTimeout(expire, Math.ceil(remaining));
  }

  return {
    signal: controller.signal,
    check() {
      if (!controller.signal.aborted && performance.now() >= options.deadline) {
        expire();
      }
      controller.signal.throwIfAborted();
    },
    normalizeError(error) {
      // Body consumption may reject with AbortError instead of the original
      // reason. Do not rewrite unrelated network/HTTP/JSON errors just
      // because another signal happened to abort at the same time.
      return controller.signal.aborted &&
        (error === controller.signal.reason ||
          (error instanceof Error && error.name === "AbortError"))
        ? controller.signal.reason
        : error;
    },
    dispose() {
      if (timer != null) clearTimeout(timer);
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}
