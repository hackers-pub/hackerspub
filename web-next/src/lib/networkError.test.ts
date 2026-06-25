import assert from "node:assert";
import test from "node:test";
import { isNetworkError, shouldReloadOnError } from "./networkError.ts";

test("isNetworkError() recognizes server function credential URL failures", () => {
  const error = new TypeError(
    "Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: /_server",
  );

  assert.equal(isNetworkError(error), true);
  assert.equal(shouldReloadOnError(error), true);
});
