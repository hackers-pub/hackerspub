import assert from "node:assert";
import test from "node:test";
import {
  isNetworkError,
  isStaleModuleLoadError,
  shouldReloadOnError,
  shouldSuppressStaleModuleError,
} from "./networkError.ts";

test("isNetworkError() recognizes server function credential URL failures", () => {
  const error = new TypeError(
    "Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: /_server",
  );

  assert.equal(isNetworkError(error), true);
  assert.equal(shouldReloadOnError(error), true);
});

test("isStaleModuleLoadError() recognizes browser chunk failures", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: /_build/chunk.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
  ]) {
    const error = new TypeError(message);
    assert.equal(isStaleModuleLoadError(error), true);
    assert.equal(isNetworkError(error), false);
    assert.equal(shouldReloadOnError(error), true);
    assert.equal(shouldSuppressStaleModuleError(error, true), true);
    assert.equal(shouldSuppressStaleModuleError(error, false), false);
  }

  assert.equal(isStaleModuleLoadError(new TypeError("fetch failed")), false);
});
