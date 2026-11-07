import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";

interface RequestWork {
  readonly signal: AbortSignal;
  readonly pending: Set<Promise<unknown>>;
  readonly outcome: MutableRequestWorkOutcome;
  readonly onFailure?: (failure: RequestWorkFailure) => void;
  generation: number;
}

const requestWork = new AsyncLocalStorage<RequestWork>();

export interface RequestWorkFailure {
  readonly kind: "overload" | "timeout";
  readonly error: unknown;
}

export interface RequestWorkOutcome {
  readonly hardFailure?: RequestWorkFailure;
  readonly dependencyInterrupted: boolean;
}

interface MutableRequestWorkOutcome {
  hardFailure?: RequestWorkFailure;
  dependencyInterrupted: boolean;
}

const emptyOutcome: RequestWorkOutcome = Object.freeze({
  dependencyInterrupted: false,
});

/** Nested scopes share outcomes; independent requests never share failures. */
export function getRequestWorkOutcome(): RequestWorkOutcome {
  return requestWork.getStore()?.outcome ?? emptyOutcome;
}

/** Record before notifying admission, so synchronous abort observers see it. */
export function reportRequestWorkFailure(failure: RequestWorkFailure): void {
  const scope = requestWork.getStore();
  if (scope == null || scope.outcome.hardFailure != null) return;
  scope.outcome.hardFailure = failure;
  scope.onFailure?.(failure);
}

/** A local lookup can fail while a best-effort response still succeeds. */
export function reportRequestDependencyInterruption(_error: unknown): void {
  const scope = requestWork.getStore();
  if (scope != null) scope.outcome.dependencyInterrupted = true;
}

/** Whether this asynchronous execution owns a bounded request work scope. */
export function hasRequestWork(): boolean {
  return requestWork.getStore() != null;
}

/** Cancellation for dependency APIs that accept an AbortSignal. */
export function getRequestWorkSignal(): AbortSignal | undefined {
  return requestWork.getStore()?.signal;
}

/** Check before starting work; already-started work must still be tracked. */
export function throwIfRequestWorkAborted(): void {
  requestWork.getStore()?.signal.throwIfAborted();
}

/**
 * Own the actual promise, even when a caller stops awaiting it or races it
 * against a timeout. Rejections remain visible to its caller and are also
 * observed here, so a deliberately abandoned branch cannot reject unhandled.
 * A transaction lifecycle belongs to its parent's scope; its callback must
 * have a separate child scope so draining cannot wait on the transaction itself.
 */
export function trackRequestWork<T>(promise: PromiseLike<T>): Promise<T> {
  const owned = Promise.resolve(promise);
  const scope = requestWork.getStore();
  if (scope == null || scope.pending.has(owned)) return owned;
  scope.pending.add(owned);
  scope.generation++;
  const settled = () => {
    scope.pending.delete(owned);
  };
  void owned.then(settled, settled);
  return owned;
}

async function drain(scope: RequestWork): Promise<void> {
  while (true) {
    if (scope.pending.size > 0) {
      await Promise.allSettled(scope.pending);
    }
    const generation = scope.generation;
    // A completed resolver can schedule nested GraphQL resolvers in later
    // promise continuations. Let that microtask chain finish before deciding
    // that the transaction and admission ownership may end.
    await setImmediate();
    if (scope.pending.size === 0 && scope.generation === generation) return;
  }
}

/** Drain the current scope without replacing the execution's original error. */
export async function drainRequestWork(): Promise<void> {
  const scope = requestWork.getStore();
  if (scope != null) await drain(scope);
}

/**
 * Keep request ownership until all registered underlying work settles, on
 * success, failure, or cancellation. AsyncLocalStorage survives application
 * context/database rebinding and keeps concurrent requests isolated.
 */
export function runWithRequestWork<T>(
  signal: AbortSignal,
  callback: () => Promise<T>,
  options: { readonly onFailure?: (failure: RequestWorkFailure) => void } = {},
): Promise<T> {
  const parent = requestWork.getStore();
  return requestWork.run(
    {
      signal,
      pending: new Set(),
      generation: 0,
      outcome: parent?.outcome ?? { dependencyInterrupted: false },
      onFailure: options.onFailure ?? parent?.onFailure,
    },
    async () => {
      try {
        throwIfRequestWorkAborted();
        return await callback();
      } finally {
        await drainRequestWork();
      }
    },
  );
}
