import assert from "node:assert/strict";
import test from "node:test";
import { installPromiseWithResolversPolyfill } from "./promiseWithResolvers.ts";

test("installPromiseWithResolversPolyfill resolves and rejects promises", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers");
  try {
    delete (Promise as { withResolvers?: PromiseConstructor["withResolvers"] })
      .withResolvers;

    installPromiseWithResolversPolyfill();

    const resolved = Promise.withResolvers<number>();
    resolved.resolve(42);
    assert.equal(await resolved.promise, 42);

    const rejected = Promise.withResolvers<number>();
    const error = new Error("boom");
    rejected.reject(error);
    await assert.rejects(rejected.promise, error);
  } finally {
    if (descriptor == null) {
      delete (
        Promise as {
          withResolvers?: PromiseConstructor["withResolvers"];
        }
      ).withResolvers;
    } else {
      Object.defineProperty(Promise, "withResolvers", descriptor);
    }
  }
});

test("installPromiseWithResolversPolyfill keeps native implementations", () => {
  const native = <T>() => {
    const promise = Promise.resolve("native");
    return {
      promise: promise as Promise<T>,
      resolve: () => {},
      reject: () => {},
    };
  };
  const descriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers");
  try {
    Object.defineProperty(Promise, "withResolvers", {
      configurable: true,
      value: native,
      writable: true,
    });

    installPromiseWithResolversPolyfill();

    assert.equal(Promise.withResolvers, native);
  } finally {
    if (descriptor == null) {
      delete (
        Promise as {
          withResolvers?: PromiseConstructor["withResolvers"];
        }
      ).withResolvers;
    } else {
      Object.defineProperty(Promise, "withResolvers", descriptor);
    }
  }
});
