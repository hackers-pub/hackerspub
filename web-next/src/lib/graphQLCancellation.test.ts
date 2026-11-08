import assert from "node:assert";
import test from "node:test";
import {
  GraphQLRequestCancelledError,
  isGraphQLCancellationEvent,
  isGraphQLRequestCancelledError,
} from "./graphQLCancellation.ts";

test("GraphQL cancellation: source and arbitrary reason survive intentional wrapping", () => {
  for (const source of ["inbound", "disposal"] as const) {
    for (const reason of [
      "closed",
      1,
      new Error("socket error"),
      Object.assign(new Error("caller timeout"), { name: "TimeoutError" }),
    ]) {
      const error = new GraphQLRequestCancelledError(source, reason);
      assert.equal(error.name, "GraphQLRequestCancelledError");
      assert.equal(error.source, source);
      assert.strictEqual(error.cause, reason);
      assert.equal(isGraphQLRequestCancelledError(error), true);
    }
  }
});

test("GraphQL cancellation: instrumentation recognizes a separate constructor copy", () => {
  class OtherCopy extends Error {
    constructor() {
      super("GraphQL request cancelled (inbound)");
      this.name = "GraphQLRequestCancelledError";
    }
  }
  const error = new OtherCopy();
  assert.equal(error instanceof GraphQLRequestCancelledError, false);
  assert.equal(isGraphQLRequestCancelledError(error), true);
  assert.equal(
    isGraphQLCancellationEvent({}, { originalException: error }),
    true,
  );
});

test("GraphQL cancellation: serialized event works without originalException", () => {
  assert.equal(
    isGraphQLCancellationEvent({
      exception: { values: [{ type: "GraphQLRequestCancelledError" }] },
    }),
    true,
  );
  assert.equal(
    isGraphQLCancellationEvent({
      exception: {
        values: [{ type: "Error" }, { type: "GraphQLRequestCancelledError" }],
      },
    }),
    true,
  );
});

test("GraphQL cancellation: ordinary failures and arbitrary aborts remain reportable", () => {
  for (const error of [
    new DOMException("unrelated abort", "AbortError"),
    Object.assign(new Error("owned deadline"), { name: "TimeoutError" }),
    new TypeError("fetch failed"),
    new SyntaxError("Unexpected end of JSON input"),
    new Error("GraphQL upstream error"),
    null,
    "GraphQLRequestCancelledError",
  ]) {
    assert.equal(isGraphQLRequestCancelledError(error), false);
    assert.equal(
      isGraphQLCancellationEvent({}, { originalException: error }),
      false,
    );
    if (error instanceof Error)
      assert.equal(
        isGraphQLCancellationEvent({
          exception: { values: [{ type: error.name }] },
        }),
        false,
      );
  }
  assert.equal(isGraphQLCancellationEvent({}), false);
  assert.equal(
    isGraphQLCancellationEvent({ exception: { values: [] } }),
    false,
  );
});

test("GraphQL cancellation: an unrelated outer failure is not suppressed merely for a cancellation cause", () => {
  const error = new Error("unrelated failure", {
    cause: new GraphQLRequestCancelledError("inbound", "closed"),
  });
  assert.equal(isGraphQLRequestCancelledError(error), false);
  assert.equal(
    isGraphQLCancellationEvent({}, { originalException: error }),
    false,
  );
  const event = {
    exception: {
      values: [{ type: "GraphQLRequestCancelledError" }, { type: "Error" }],
    },
  };
  assert.equal(isGraphQLCancellationEvent(event), false);
  assert.equal(
    isGraphQLCancellationEvent(event, { originalException: error }),
    false,
  );
});
