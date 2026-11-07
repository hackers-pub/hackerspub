import type { FetchFunction, GraphQLResponse } from "relay-runtime";
import { Observable } from "relay-runtime";

function fromCancellablePromise(
  promise: PromiseLike<GraphQLResponse>,
): Observable<GraphQLResponse> {
  return Observable.create((sink) => {
    let active = true;
    void Promise.resolve(promise).then(
      (value) => {
        if (!active) return;
        sink.next(value);
        sink.complete();
      },
      (error: Error) => {
        if (active) sink.error(error);
      },
    );
    return () => {
      active = false;
    };
  });
}

/** Keep cancellation available until the transport response has settled. */
export function createRelayResponseObservable(
  response: ReturnType<FetchFunction>,
  controller: AbortController,
): Observable<GraphQLResponse> {
  return Observable.create((sink) => {
    let pending = true;
    const streaming =
      typeof response === "object" &&
      response !== null &&
      typeof (response as { subscribe?: unknown }).subscribe === "function";
    const promise =
      response != null &&
      typeof (response as { then?: unknown }).then === "function";
    const observable = promise
      ? fromCancellablePromise(response as PromiseLike<GraphQLResponse>)
      : Observable.from(response);
    const subscription = observable.subscribe({
      next(value) {
        // A Promise or plain value has settled before next(). A subscriber
        // may unsubscribe here before Relay forwards complete(). Streams
        // still need cancellation until completion or an error.
        if (!streaming) pending = false;
        sink.next(value);
      },
      complete() {
        pending = false;
        sink.complete();
      },
      error(error: Error) {
        pending = false;
        sink.error(error);
      },
    });
    return () => {
      // Stop Promise forwarding before aborting: its rejection must not hit
      // a closed Relay sink and become an unhandled-error report.
      subscription.unsubscribe();
      if (pending) controller.abort();
    };
  });
}
