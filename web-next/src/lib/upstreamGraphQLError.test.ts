import assert from "node:assert";
import test from "node:test";
import {
  isTransientUpstreamGraphQLErrorEvent,
  shouldCaptureUpstreamError,
  TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX,
  TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME,
  TransientUpstreamGraphQLError,
} from "./upstreamGraphQLError.ts";

test("shouldCaptureUpstreamError suppresses empty gateway failures", () => {
  for (const status of [502, 503, 504]) {
    assert.equal(
      shouldCaptureUpstreamError({ status, responseText: "" }),
      false,
    );
    assert.equal(
      shouldCaptureUpstreamError({ status, responseText: "   \n" }),
      false,
    );
  }
});

test("shouldCaptureUpstreamError keeps diagnostic upstream failures", () => {
  assert.equal(
    shouldCaptureUpstreamError({ status: 504, responseText: "timeout" }),
    true,
  );
  assert.equal(shouldCaptureUpstreamError({ status: 504 }), true);
  assert.equal(
    shouldCaptureUpstreamError({
      status: 504,
      responseText: "",
      errors: [{ message: "resolver failed" }],
    }),
    true,
  );
  assert.equal(
    shouldCaptureUpstreamError({ status: 500, responseText: "" }),
    true,
  );
});

test("TransientUpstreamGraphQLError is identifiable in Sentry events", () => {
  const error = new TransientUpstreamGraphQLError("appQuery", 504);

  assert.equal(error.name, TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME);
  assert.equal(
    isTransientUpstreamGraphQLErrorEvent(
      {},
      {
        originalException: error,
      },
    ),
    true,
  );
  assert.equal(
    isTransientUpstreamGraphQLErrorEvent({
      exception: {
        values: [
          {
            type: TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME,
          },
        ],
      },
    }),
    true,
  );
  assert.equal(
    isTransientUpstreamGraphQLErrorEvent({
      exception: {
        values: [
          {
            type: "TypeError",
            value: `${TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX}504 for appQuery`,
          },
        ],
      },
    }),
    true,
  );
  assert.equal(
    isTransientUpstreamGraphQLErrorEvent({
      exception: { values: [{ type: "Error" }] },
    }),
    false,
  );
});
