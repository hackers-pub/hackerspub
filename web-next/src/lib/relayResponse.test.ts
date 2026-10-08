import assert from "node:assert";
import test from "node:test";
import { Observable, type GraphQLResponse } from "relay-runtime";
import { createRelayResponseObservable } from "./relayResponse.ts";

const response = { data: { __typename: "Query" } };

test("Relay responses: unsubscribe inside next does not abort settled values", async () => {
  for (const result of [response, Promise.resolve(response)]) {
    const controller = new AbortController();
    let subscription: { unsubscribe(): void };
    const received = await new Promise<GraphQLResponse>((resolve, reject) => {
      createRelayResponseObservable(result, controller).subscribe({
        start(value) {
          subscription = value;
        },
        next(value) {
          subscription.unsubscribe();
          resolve(value);
        },
        error: reject,
      });
    });
    assert.deepEqual(received, response);
    assert.equal(controller.signal.aborted, false);
  }
});

test("Relay responses: unsubscribing aborts a pending request", async () => {
  const controller = new AbortController();
  let finish!: (value: GraphQLResponse) => void;
  const pending = new Promise<GraphQLResponse>((resolve) => {
    finish = resolve;
  });
  const values: GraphQLResponse[] = [];
  const subscription = createRelayResponseObservable(
    pending,
    controller,
  ).subscribe({ next: (value) => values.push(value) });
  subscription.unsubscribe();
  assert.equal(controller.signal.aborted, true);
  finish(response);
  await pending;
  assert.deepEqual(values, []);
});

test("Relay responses: streams remain cancellable after emitting a value", () => {
  const controller = new AbortController();
  let emit!: (value: GraphQLResponse) => void;
  let cleaned = false;
  const stream = Observable.create<GraphQLResponse>((sink) => {
    emit = sink.next;
    return () => {
      cleaned = true;
    };
  });
  const values: GraphQLResponse[] = [];
  const subscription = createRelayResponseObservable(
    stream,
    controller,
  ).subscribe({ next: (value) => values.push(value) });
  emit(response);
  assert.deepEqual(values, [response]);
  subscription.unsubscribe();
  assert.equal(controller.signal.aborted, true);
  assert.equal(cleaned, true);
});

test("Relay responses: completion and errors release the controller", async () => {
  const failed = new Error("Transport failed");
  const cases = [
    Observable.create<GraphQLResponse>((sink) => sink.complete()),
    Observable.create<GraphQLResponse>((sink) => sink.error(failed)),
    Promise.reject(failed),
  ];
  for (const [index, result] of cases.entries()) {
    const controller = new AbortController();
    let reported: Error | undefined;
    await new Promise<void>((resolve) => {
      createRelayResponseObservable(result, controller).subscribe({
        complete: resolve,
        error(error: Error) {
          reported = error;
          resolve();
        },
      });
    });
    assert.equal(reported, index === 0 ? undefined : failed);
    assert.equal(controller.signal.aborted, false);
  }
});
