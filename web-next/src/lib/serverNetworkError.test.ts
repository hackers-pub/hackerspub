import assert from "node:assert";
import test from "node:test";
import { isServerNetworkError } from "./serverNetworkError.ts";

test("isServerNetworkError() recognizes Node fetch transport failures", () => {
  const socketError = Object.assign(new Error("socket closed"), {
    code: "UND_ERR_SOCKET",
  });
  assert.equal(
    isServerNetworkError(new TypeError("fetch failed", { cause: socketError })),
    true,
  );

  const connectionErrors = new AggregateError([
    Object.assign(new Error("IPv6 refused"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("IPv4 refused"), { code: "ECONNREFUSED" }),
  ]);
  assert.equal(
    isServerNetworkError(
      new TypeError("fetch failed", { cause: connectionErrors }),
    ),
    true,
  );

  assert.equal(
    isServerNetworkError(new TypeError("terminated", { cause: socketError })),
    true,
  );
});

test("isServerNetworkError() keeps application fetch failures", () => {
  assert.equal(
    isServerNetworkError(
      new TypeError("fetch failed", { cause: new Error("bad response") }),
    ),
    false,
  );
  assert.equal(
    isServerNetworkError(
      Object.assign(new Error("database refused"), { code: "ECONNREFUSED" }),
    ),
    false,
  );
  assert.equal(
    isServerNetworkError(
      new AggregateError([
        Object.assign(new Error("database refused"), {
          code: "ECONNREFUSED",
        }),
      ]),
    ),
    false,
  );
});
