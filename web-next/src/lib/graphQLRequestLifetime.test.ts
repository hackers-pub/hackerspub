import assert from "node:assert";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";
import { GraphQLRequestCancelledError } from "./graphQLCancellation.ts";
import { createGraphQLRequestLifetime } from "./graphQLRequestLifetime.ts";

function clock(t: TestContext, initial = 1000) {
  let now = initial;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  return {
    advance(milliseconds: number) {
      now += milliseconds;
      t.mock.timers.tick(milliseconds);
    },
    elapse(milliseconds: number) {
      now += milliseconds;
    },
  };
}

test("GraphQL lifetime: owned expiry is a timeout without aborting source controllers", (t) => {
  const time = clock(t);
  const inbound = new AbortController();
  const operation = new AbortController();
  const lifetime = createGraphQLRequestLifetime({
    deadline: 1050,
    timeoutMessage: "SSR GraphQL deadline exceeded",
    requestSignal: inbound.signal,
    operationSignal: operation.signal,
  });
  try {
    time.advance(49);
    lifetime.check();
    time.advance(1);
    assert.throws(() => lifetime.check(), {
      name: "TimeoutError",
      message: "SSR GraphQL deadline exceeded",
    });
    assert.equal(lifetime.signal.reason instanceof TypeError, false);
    assert.equal(inbound.signal.aborted, false);
    assert.equal(operation.signal.aborted, false);
  } finally {
    lifetime.dispose();
  }
});

for (const reason of [
  "disconnected",
  7,
  new Error("closed"),
  Object.assign(new Error("caller timeout"), { name: "TimeoutError" }),
]) {
  test(`GraphQL lifetime: inbound ${String(reason)} retains deliberate provenance`, (t) => {
    clock(t);
    const inbound = new AbortController();
    const lifetime = createGraphQLRequestLifetime({
      deadline: 1100,
      timeoutMessage: "owned timeout",
      requestSignal: inbound.signal,
    });
    try {
      inbound.abort(reason);
      const cancellation = lifetime.signal.reason;
      assert.ok(cancellation instanceof GraphQLRequestCancelledError);
      assert.equal(cancellation.source, "inbound");
      assert.strictEqual(cancellation.cause, reason);
      assert.throws(
        () => lifetime.check(),
        (error) => error === cancellation,
      );
    } finally {
      lifetime.dispose();
    }
  });
}

test("GraphQL lifetime: disposal is distinct and first cancellation wins", (t) => {
  const time = clock(t);
  const inbound = new AbortController();
  const operation = new AbortController();
  const reason = new Error("preload disposed");
  const lifetime = createGraphQLRequestLifetime({
    deadline: 1010,
    timeoutMessage: "owned timeout",
    requestSignal: inbound.signal,
    operationSignal: operation.signal,
  });
  try {
    operation.abort(reason);
    const first = lifetime.signal.reason;
    assert.ok(first instanceof GraphQLRequestCancelledError);
    assert.equal(first.source, "disposal");
    assert.strictEqual(first.cause, reason);
    assert.equal(inbound.signal.aborted, false);
    inbound.abort(new Error("later disconnect"));
    time.advance(20);
    assert.strictEqual(lifetime.signal.reason, first);
  } finally {
    lifetime.dispose();
  }
});

test("GraphQL lifetime: later disposal cannot hide an owned timeout", (t) => {
  const time = clock(t);
  const operation = new AbortController();
  const lifetime = createGraphQLRequestLifetime({
    deadline: 1010,
    timeoutMessage: "owned timeout",
    operationSignal: operation.signal,
  });
  try {
    time.advance(10);
    const timeout = lifetime.signal.reason;
    operation.abort();
    assert.equal(timeout.name, "TimeoutError");
    assert.strictEqual(lifetime.signal.reason, timeout);
  } finally {
    lifetime.dispose();
  }
});

for (const source of ["inbound", "disposal"] as const) {
  test(`GraphQL lifetime: pre-aborted ${source} prevents dispatch and owns no timer`, (t) => {
    const time = clock(t);
    const setTimer = t.mock.method(globalThis, "setTimeout");
    const aborted = new AbortController();
    aborted.abort("already cancelled");
    const other = new AbortController();
    const lifetime = createGraphQLRequestLifetime({
      deadline: 1100,
      timeoutMessage: "owned timeout",
      requestSignal: source === "inbound" ? aborted.signal : other.signal,
      operationSignal: source === "disposal" ? aborted.signal : other.signal,
    });
    assert.equal(setTimer.mock.callCount(), 0);
    let dispatched = false;
    try {
      assert.throws(
        () => {
          lifetime.check();
          dispatched = true;
        },
        (error) =>
          error instanceof GraphQLRequestCancelledError &&
          error.source === source,
      );
      assert.equal(dispatched, false);
      const reason = lifetime.signal.reason;
      time.advance(1000);
      assert.strictEqual(lifetime.signal.reason, reason);
    } finally {
      lifetime.dispose();
    }
    assert.equal(getEventListeners(other.signal, "abort").length, 0);
  });
}

test("GraphQL lifetime: exhausted budget prevents work immediately", (t) => {
  const time = clock(t);
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const lifetime = createGraphQLRequestLifetime({
    deadline: 999,
    timeoutMessage: "page budget exhausted",
  });
  assert.equal(setTimer.mock.callCount(), 0);
  let dispatched = false;
  try {
    assert.throws(
      () => {
        lifetime.check();
        dispatched = true;
      },
      { name: "TimeoutError", message: "page budget exhausted" },
    );
    assert.equal(dispatched, false);
    const reason = lifetime.signal.reason;
    time.advance(1000);
    assert.strictEqual(lifetime.signal.reason, reason);
  } finally {
    lifetime.dispose();
  }
});

test("GraphQL lifetime: successful-stage checks reject elapsed budgets before timer delivery", (t) => {
  const time = clock(t);
  const lifetime = createGraphQLRequestLifetime({
    deadline: 1010,
    timeoutMessage: "late success",
  });
  try {
    lifetime.check();
    time.elapse(11);
    assert.equal(lifetime.signal.aborted, false);
    assert.throws(() => lifetime.check(), {
      name: "TimeoutError",
      message: "late success",
    });
    assert.equal(lifetime.signal.aborted, true);
  } finally {
    lifetime.dispose();
  }
});

test("GraphQL lifetime: normalization preserves unrelated errors even after cancellation", (t) => {
  clock(t);
  const inbound = new AbortController();
  const lifetime = createGraphQLRequestLifetime({
    deadline: 1100,
    timeoutMessage: "owned timeout",
    requestSignal: inbound.signal,
  });
  const abort = new DOMException("body aborted", "AbortError");
  const network = new TypeError("fetch failed");
  const syntax = new SyntaxError("Unexpected end of JSON input");
  try {
    assert.strictEqual(lifetime.normalizeError(abort), abort);
    inbound.abort("closed");
    assert.strictEqual(lifetime.normalizeError(abort), lifetime.signal.reason);
    assert.strictEqual(
      lifetime.normalizeError(lifetime.signal.reason),
      lifetime.signal.reason,
    );
    assert.strictEqual(lifetime.normalizeError(network), network);
    assert.strictEqual(lifetime.normalizeError(syntax), syntax);
    assert.strictEqual(
      lifetime.normalizeError("arbitrary failure"),
      "arbitrary failure",
    );
  } finally {
    lifetime.dispose();
  }
});

test("GraphQL lifetime: generic body AbortError retains owned timeout identity", (t) => {
  const time = clock(t);
  const lifetime = createGraphQLRequestLifetime({
    deadline: 1001,
    timeoutMessage: "body budget exceeded",
  });
  try {
    time.advance(1);
    const timeout = lifetime.signal.reason;
    assert.equal(timeout.name, "TimeoutError");
    assert.strictEqual(
      lifetime.normalizeError(new DOMException("aborted", "AbortError")),
      timeout,
    );
  } finally {
    lifetime.dispose();
  }
});

for (const outcome of ["success", "error"] as const) {
  test(`GraphQL lifetime: ${outcome} cleanup restores source listeners and clears deadline`, (t) => {
    const time = clock(t);
    const inbound = new AbortController();
    const operation = new AbortController();
    const existing = () => {};
    inbound.signal.addEventListener("abort", existing);
    const inboundBaseline = getEventListeners(inbound.signal, "abort").length;
    const operationBaseline = getEventListeners(
      operation.signal,
      "abort",
    ).length;
    const lifetime = createGraphQLRequestLifetime({
      deadline: 1010,
      timeoutMessage: "unused timeout",
      requestSignal: inbound.signal,
      operationSignal: operation.signal,
    });
    assert.equal(
      getEventListeners(inbound.signal, "abort").length,
      inboundBaseline + 1,
    );
    assert.equal(
      getEventListeners(operation.signal, "abort").length,
      operationBaseline + 1,
    );
    const failure = new Error("transport failure");
    const execute = () => {
      try {
        lifetime.check();
        if (outcome === "error") throw failure;
      } finally {
        lifetime.dispose();
      }
    };
    if (outcome === "error")
      assert.throws(execute, (error) => error === failure);
    else execute();
    assert.equal(
      getEventListeners(inbound.signal, "abort").length,
      inboundBaseline,
    );
    assert.equal(
      getEventListeners(operation.signal, "abort").length,
      operationBaseline,
    );
    time.advance(1000);
    inbound.abort();
    operation.abort();
    assert.equal(lifetime.signal.aborted, false);
    lifetime.dispose();
  });
}

for (const source of ["inbound", "disposal", "timeout"] as const) {
  test(`GraphQL lifetime: ${source} cleanup releases the remaining source listener`, (t) => {
    const time = clock(t);
    const inbound = new AbortController();
    const operation = new AbortController();
    const lifetime = createGraphQLRequestLifetime({
      deadline: 1010,
      timeoutMessage: "owned timeout",
      requestSignal: inbound.signal,
      operationSignal: operation.signal,
    });
    try {
      if (source === "inbound") inbound.abort("disconnected");
      else if (source === "disposal") operation.abort("disposed");
      else time.advance(10);
      const first = lifetime.signal.reason;
      assert.throws(
        () => lifetime.check(),
        (error) => error === first,
      );
      assert.equal(
        getEventListeners(inbound.signal, "abort").length,
        source === "inbound" ? 0 : 1,
      );
      assert.equal(
        getEventListeners(operation.signal, "abort").length,
        source === "disposal" ? 0 : 1,
      );
    } finally {
      lifetime.dispose();
    }
    assert.equal(getEventListeners(inbound.signal, "abort").length, 0);
    assert.equal(getEventListeners(operation.signal, "abort").length, 0);
  });
}
