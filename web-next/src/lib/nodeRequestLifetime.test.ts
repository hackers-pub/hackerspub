import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { createNodeRequestLifetime } from "./nodeRequestLifetime.ts";

function fixture() {
  const request = Object.assign(new EventEmitter(), {
    aborted: false,
    errored: null,
  }) as IncomingMessage;
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
  }) as ServerResponse;
  const original = new AbortController();
  const released = () => {
    assert.equal(request.listenerCount("aborted"), 0);
    assert.equal(request.listenerCount("error"), 0);
    assert.equal(response.listenerCount("close"), 0);
    assert.equal(response.listenerCount("finish"), 0);
    assert.equal(getEventListeners(original.signal, "abort").length, 0);
  };
  return { request, response, original, released };
}

test("Node inbound lifetime preserves the original abort reason and releases listeners", () => {
  const { request, response, original, released } = fixture();
  const lifetime = createNodeRequestLifetime(
    request,
    response,
    original.signal,
  );
  const reason = new Error("Caller cancelled");
  original.abort(reason);
  assert.equal(lifetime.signal.reason, reason);
  released();
});

test("Node inbound lifetime handles request aborts and errors", () => {
  for (const event of ["aborted", "error"]) {
    const { request, response, original, released } = fixture();
    const lifetime = createNodeRequestLifetime(
      request,
      response,
      original.signal,
    );
    const reason = new Error("Socket closed");
    request.emit(event, reason);
    assert.equal(lifetime.signal.aborted, true);
    if (event === "error") assert.equal(lifetime.signal.reason, reason);
    else assert.equal(lifetime.signal.reason.name, "AbortError");
    assert.equal(original.signal.aborted, false);
    released();
  }
});

test("Node inbound lifetime ignores request-body close but cancels unfinished responses", () => {
  const { request, response, original, released } = fixture();
  const lifetime = createNodeRequestLifetime(
    request,
    response,
    original.signal,
  );
  request.emit("close");
  assert.equal(lifetime.signal.aborted, false);
  // end() may have been called while output is still buffered.
  Object.defineProperty(response, "writableEnded", { value: true });
  response.emit("close");
  assert.equal(lifetime.signal.aborted, true);
  released();
});

test("Node inbound lifetime cleans normal finish without cancelling successful work", () => {
  const { request, response, original, released } = fixture();
  const lifetime = createNodeRequestLifetime(
    request,
    response,
    original.signal,
  );
  Object.defineProperty(response, "writableFinished", { value: true });
  response.emit("finish");
  response.emit("close");
  assert.equal(lifetime.signal.aborted, false);
  released();
});

test("Node inbound lifetime handles already aborted, closed and finished requests", () => {
  for (const state of ["aborted", "closed", "finished", "original"]) {
    const { request, response, original, released } = fixture();
    if (state === "aborted")
      Object.defineProperty(request, "aborted", { value: true });
    if (state === "closed")
      Object.defineProperty(response, "destroyed", { value: true });
    if (state === "finished")
      Object.defineProperty(response, "writableFinished", { value: true });
    if (state === "original") original.abort("Already cancelled");
    const lifetime = createNodeRequestLifetime(
      request,
      response,
      original.signal,
    );
    assert.equal(lifetime.signal.aborted, state !== "finished");
    if (state === "original")
      assert.equal(lifetime.signal.reason, "Already cancelled");
    released();
  }
});

test("Node inbound lifetime can release construction failures without affecting another request", () => {
  const first = fixture();
  const second = fixture();
  const a = createNodeRequestLifetime(
    first.request,
    first.response,
    first.original.signal,
  );
  const b = createNodeRequestLifetime(
    second.request,
    second.response,
    second.original.signal,
  );
  a.dispose();
  a.dispose();
  first.released();
  assert.equal(a.signal.aborted, false);
  assert.equal(b.signal.aborted, false);
  second.response.emit("close");
  assert.equal(b.signal.aborted, true);
  assert.equal(a.signal.aborted, false);
  second.released();
});
