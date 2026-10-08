import type { FetchFunction, GraphQLResponse } from "relay-runtime";
import { Observable } from "relay-runtime";

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
    const subscription = Observable.from(response).subscribe({
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
      if (pending) controller.abort();
      subscription.unsubscribe();
    };
  });
}
