interface NodeResponse {
  readonly writableFinished: boolean;
  readonly destroyed: boolean;
  once(event: "finish" | "close", listener: () => void): unknown;
  off(event: "finish" | "close", listener: () => void): unknown;
  destroy(): unknown;
}

interface ResponseLifetime {
  readonly finished: Promise<void>;
  limit(milliseconds: number, onTimeout: () => void): void;
  start(status: number): void;
}

const lifetimes = new WeakMap<Request, ResponseLifetime>();

/** A Fetch response is ready before Node has finished writing its bytes. */
export function getResponseLifetime(
  request: Request,
): ResponseLifetime | undefined {
  return lifetimes.get(request);
}

export function attachResponseLifetime(
  request: Request,
  response: NodeResponse,
): ResponseLifetime {
  const finished = Promise.withResolvers<void>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: { expires: number; onTimeout: () => void } | undefined;
  const complete = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    response.off("finish", complete);
    response.off("close", complete);
    finished.resolve();
  };
  response.once("finish", complete);
  response.once("close", complete);
  if (response.writableFinished || response.destroyed) complete();
  const lifetime: ResponseLifetime = {
    finished: finished.promise,
    limit(milliseconds, onTimeout) {
      deadline = { expires: performance.now() + milliseconds, onTimeout };
    },
    start(status) {
      if (settled || deadline == null || timer != null) return;
      const { expires, onTimeout } = deadline;
      const remaining = expires - performance.now();
      // Successful transmission shares the original monotonic request budget.
      // An error generated after it expires gets a fixed, bounded opportunity
      // to flush the retryable reply before we destroy the socket.
      const milliseconds = remaining > 0 ? remaining : status >= 400 ? 1000 : 0;
      timer = setTimeout(() => {
        // Destroy once, then wait for the actual close event. This ends only
        // transport ownership: unfinished SQL/loaders still retain the permit.
        onTimeout();
        response.destroy();
      }, milliseconds);
    },
  };
  lifetimes.set(request, lifetime);
  return lifetime;
}
