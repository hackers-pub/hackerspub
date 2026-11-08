import type { IncomingMessage, ServerResponse } from "node:http";

/** Restore Node disconnect cancellation across Nitro's Web Request adapter. */
export function createNodeRequestLifetime(
  request: IncomingMessage,
  response: ServerResponse,
  originalSignal: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const dispose = () => {
    request.removeListener("aborted", onAborted);
    request.removeListener("error", onError);
    response.removeListener("close", onClose);
    response.removeListener("finish", dispose);
    originalSignal.removeEventListener("abort", onOriginalAbort);
  };
  const abort = (reason: unknown) => {
    controller.abort(reason);
    dispose();
  };
  const onAborted = () => {
    abort(
      request.errored ?? new DOMException("Client disconnected", "AbortError"),
    );
  };
  const onError = (error: Error) => abort(error);
  const onClose = () => {
    if (!response.writableFinished) onAborted();
    else dispose();
  };
  const onOriginalAbort = () => abort(originalSignal.reason);

  if (originalSignal.aborted) onOriginalAbort();
  else if (
    request.aborted ||
    (response.destroyed && !response.writableFinished)
  )
    onAborted();
  else if (!response.writableFinished) {
    request.once("aborted", onAborted);
    request.once("error", onError);
    response.once("close", onClose);
    response.once("finish", dispose);
    originalSignal.addEventListener("abort", onOriginalAbort, { once: true });
  }
  return { signal: controller.signal, dispose };
}
