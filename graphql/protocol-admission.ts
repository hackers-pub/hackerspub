import {
  getRequestWorkOutcome,
  runWithRequestWork,
  type RequestWorkOutcome,
} from "@hackerspub/models/request-work";
import type { ProtocolHttpConfig } from "@hackerspub/runtime/config";
import { getResponseLifetime } from "./response-lifetime.ts";

class ProtocolBodyLimitError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Protocol body exceeds the configured byte limit.");
    this.status = status;
  }
}

function failureResponse(status: number): Response {
  return new Response(
    status === 413
      ? "Payload Too Large"
      : status === 499
        ? null
        : status === 504
          ? "Gateway Timeout"
          : status === 500
            ? "Internal Server Error"
            : "Service Unavailable",
    {
      status,
      headers: {
        "content-type": "text/plain; charset=UTF-8",
        "cache-control": "no-store",
        connection: "close",
        ...(status === 503 ? { "retry-after": "1" } : {}),
      },
    },
  );
}

/** Await response cancellation too; the incoming socket closes after the reply. */
async function readBytes(
  body: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
  incoming: boolean,
): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (reason: unknown) => {
    cancellation ??= reader.cancel(reason).catch(() => {});
  };
  const onAbort = () => cancel(signal.reason);
  if (!incoming) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ProtocolBodyLimitError(incoming ? 413 : 500);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } catch (error) {
    // Cancelling an IncomingMessage can destroy its socket before the retryable
    // reply is written. Connection: close instead ends it after that reply.
    if (!incoming) cancel(error);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancellation;
    reader.releaseLock();
  }
}

export interface ProtocolAdmissionStats {
  readonly active: number;
  readonly limit: number;
  readonly queued: 0;
  readonly stopping: boolean;
  readonly admitted: number;
  readonly completed: number;
  readonly rejected: number;
  readonly timedOut: number;
  readonly cancelled: number;
}

/** No waiting queue. A caller can leave before its owned work finishes. */
export class ProtocolAdmission {
  readonly config: ProtocolHttpConfig;
  readonly #aborters = new Set<() => void>();
  #stopping = false;
  #admitted = 0;
  #completed = 0;
  #rejected = 0;
  #timedOut = 0;
  #cancelled = 0;
  #idle: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  constructor(config: ProtocolHttpConfig) {
    for (const [name, value] of Object.entries(config)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new RangeError(
          `Protocol ${name} must be a positive bounded integer.`,
        );
      }
    }
    this.config = config;
  }

  get stats(): ProtocolAdmissionStats {
    return {
      active: this.#aborters.size,
      limit: this.config.limit,
      queued: 0,
      stopping: this.#stopping,
      admitted: this.#admitted,
      completed: this.#completed,
      rejected: this.#rejected,
      timedOut: this.#timedOut,
      cancelled: this.#cancelled,
    };
  }

  stop(): void {
    this.#stopping = true;
  }

  abort(): void {
    this.stop();
    for (const abort of this.#aborters) abort();
  }

  idle(): Promise<void> {
    return this.#idle?.promise ?? Promise.resolve();
  }

  run(
    request: Request,
    execute: (request: Request) => Promise<Response>,
  ): Promise<Response> {
    if (request.signal.aborted) return Promise.resolve(failureResponse(499));
    if (this.#stopping || this.#aborters.size >= this.config.limit) {
      this.#rejected++;
      return Promise.resolve(failureResponse(503));
    }
    const controller = new AbortController();
    const transport = getResponseLifetime(request);
    const interrupted = Promise.withResolvers<Response>();
    let failureStatus: number | undefined;
    let outcome: RequestWorkOutcome = { dependencyInterrupted: false };
    const abort = (status: number, reason: unknown) => {
      if (failureStatus != null) return;
      failureStatus = status;
      if (status === 504) this.#timedOut++;
      if (status === 499) this.#cancelled++;
      controller.abort(reason);
      interrupted.resolve(failureResponse(status));
    };
    const onDisconnect = () => abort(499, request.signal.reason);
    const onShutdown = () =>
      abort(
        503,
        new DOMException("Protocol service is stopping.", "AbortError"),
      );
    transport?.limit(this.config.deadlineMs, () =>
      abort(
        504,
        new DOMException(
          "Protocol response write deadline exceeded.",
          "TimeoutError",
        ),
      ),
    );
    this.#aborters.add(onShutdown);
    this.#idle ??= Promise.withResolvers<void>();
    this.#admitted++;
    request.signal.addEventListener("abort", onDisconnect, { once: true });
    if (request.signal.aborted) onDisconnect();
    const timer = setTimeout(
      () =>
        abort(
          504,
          new DOMException(
            "Protocol request deadline exceeded.",
            "TimeoutError",
          ),
        ),
      this.config.deadlineMs,
    );
    const work = runWithRequestWork(
      controller.signal,
      async () => {
        outcome = getRequestWorkOutcome();
        const length = request.headers.get("content-length");
        if (
          length != null &&
          /^\d+$/.test(length) &&
          Number(length) > this.config.bodyLimitBytes
        ) {
          throw new ProtocolBodyLimitError(413);
        }
        const body =
          request.body == null ||
          request.method === "GET" ||
          request.method === "HEAD"
            ? undefined
            : await readBytes(
                request.body,
                this.config.bodyLimitBytes,
                controller.signal,
                true,
              );
        controller.signal.throwIfAborted();
        const admitted = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body,
          signal: controller.signal,
        });
        const response = await execute(admitted);
        const bytes =
          response.body == null
            ? null
            : await readBytes(
                response.body,
                this.config.responseLimitBytes,
                controller.signal,
                false,
              );
        controller.signal.throwIfAborted();
        return new Response(request.method === "HEAD" ? null : bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      {
        onFailure: (failure) =>
          abort(failure.kind === "overload" ? 503 : 504, failure.error),
      },
    )
      .then(
        (response) =>
          failureStatus != null
            ? failureResponse(failureStatus)
            : outcome.dependencyInterrupted && response.status >= 400
              ? failureResponse(504)
              : response,
        (error: unknown) => {
          if (failureStatus != null) return failureResponse(failureStatus);
          if (outcome.dependencyInterrupted) return failureResponse(504);
          if (error instanceof ProtocolBodyLimitError)
            return failureResponse(error.status);
          throw error;
        },
      )
      .finally(() => {
        clearTimeout(timer);
      });
    // Resolve Fetch as soon as the response is ready, but retain ownership
    // until both dependencies and Node's buffered write have finished/closed.
    const release = () => {
      request.signal.removeEventListener("abort", onDisconnect);
      this.#aborters.delete(onShutdown);
      this.#completed++;
      if (this.#aborters.size === 0) {
        this.#idle?.resolve();
        this.#idle = undefined;
      }
    };
    if (transport == null) {
      // Preserve direct Fetch callers' completion boundary.
      void work.then(release, release);
    } else {
      void Promise.allSettled([work, transport.finished]).then(release);
    }
    // The race bounds the caller's wait, never the lifetime of the permit.
    return Promise.race([work, interrupted.promise]);
  }
}
