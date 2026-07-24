import assert from "node:assert/strict";
import test from "node:test";
import { reportUnhandledRejection } from "./unhandled-rejection.ts";

test("remote unhandled rejections are logged without Sentry capture", () => {
  const warnings: unknown[] = [];
  const captures: unknown[] = [];
  const remoteError = new SyntaxError("Unexpected end of JSON input");
  const result = reportUnhandledRejection(
    remoteError,
    {
      warning(_message, properties) {
        warnings.push(properties.error);
      },
    },
    {
      captureException(error) {
        captures.push(error);
      },
    },
  );

  assert.equal(result, "remote");
  assert.deepEqual(warnings, [remoteError]);
  assert.deepEqual(captures, []);
});

test("Node fetch rejections are logged without Sentry capture", () => {
  const warnings: unknown[] = [];
  const captures: unknown[] = [];
  const cause = Object.assign(new Error("getaddrinfo ENOTFOUND peer.example"), {
    code: "ENOTFOUND",
  });
  const remoteError = new TypeError("fetch failed", { cause });
  const result = reportUnhandledRejection(
    remoteError,
    {
      warning(_message, properties) {
        warnings.push(properties.error);
      },
    },
    {
      captureException(error) {
        captures.push(error);
      },
    },
  );

  assert.equal(result, "remote");
  assert.deepEqual(warnings, [remoteError]);
  assert.deepEqual(captures, []);
});

test("application unhandled rejections are captured exactly once", () => {
  const captures: Array<{ error: unknown; hint: unknown }> = [];
  const applicationError = new Error("application bug");
  const result = reportUnhandledRejection(
    applicationError,
    { warning() {} },
    {
      captureException(error, hint) {
        captures.push({ error, hint });
      },
    },
  );

  assert.equal(result, "captured");
  assert.equal(captures.length, 1);
  assert.strictEqual(captures[0]?.error, applicationError);
  assert.deepEqual(captures[0]?.hint, {
    mechanism: { type: "onunhandledrejection", handled: false },
  });
});

test("Sentry failures do not escape the unhandled rejection reporter", () => {
  const warnings: unknown[] = [];
  const applicationError = new Error("application bug");
  const captureError = new Error("Sentry failed");
  const result = reportUnhandledRejection(
    applicationError,
    {
      warning(_message, properties) {
        warnings.push(properties.error);
      },
    },
    {
      captureException() {
        throw captureError;
      },
    },
  );

  assert.equal(result, "captured");
  assert.deepEqual(warnings, [applicationError, captureError]);
});
