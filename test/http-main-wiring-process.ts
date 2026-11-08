/** Isolated composition test: resources/transport are replaced, main is real. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as config from "../runtime/config.ts";
import { anonymousReadLedgerKey } from "../runtime/anonymous-read-admission.ts";
import type { GraphqlApiHandlerOptions } from "../graphql/api.ts";
import type { createRuntimeResources } from "../runtime/resources.ts";

const role = process.argv[2] as "interactive" | "protocol" | "combined";
assert.ok(["interactive", "protocol", "combined"].includes(role));
const startupFailure = process.argv[3];
if (startupFailure != null) assert.notEqual(role, "protocol");
const closed: string[] = [];
let yogaCreated = false;
let transportCreated = false;
let listening = false;
process.env.HTTP_ROLE = role;
process.env.ANONYMOUS_READ_GLOBAL_LIMIT = "8";
process.env.PROTOCOL_SQL_LIMIT = "7";
process.env.PROTOCOL_SQL_TIMEOUT_MS = "333";
process.env.PROTOCOL_LOADER_LIMIT = "3";
process.env.PROTOCOL_LOADER_TIMEOUT_MS = "222";
let capturedConfig: Parameters<typeof createRuntimeResources>[0] | undefined;
let capturedOptions: Parameters<typeof createRuntimeResources>[2] | undefined;
let handlerOptions: GraphqlApiHandlerOptions | undefined;
const store = {
  failure: startupFailure as string | undefined,
  acquire: async () => false,
  release: async () => {},
  close: async () => {
    closed.push("store");
  },
};
mock.module(new URL("../graphql/logging.ts", import.meta.url).href, {
  namedExports: {},
});
mock.module(
  pathToFileURL(
    createRequire(new URL("../graphql/package.json", import.meta.url)).resolve(
      "@sentry/node-sdk",
    ),
  ).href,
  {
    namedExports: {
      close: async () => {},
      captureException: () => {},
    },
  },
);
mock.module("@hackerspub/runtime/config", {
  namedExports: {
    ...config,
    loadGraphqlApiConfig: () => ({
      database: { url: "postgres://unused/test" },
      kv: { url: new URL("redis://unused:6379") },
      origin: new URL("https://fixture.example"),
    }),
  },
});
mock.module("@hackerspub/runtime/resources", {
  namedExports: {
    FILE_SYSTEM_STORAGE_BASE_URL: new URL("file:///unused/"),
    createRuntimeResources: async (
      runtimeConfig: Parameters<typeof createRuntimeResources>[0],
      _version: string,
      options: Parameters<typeof createRuntimeResources>[2],
    ) => {
      capturedConfig = runtimeConfig;
      capturedOptions = options;
      return {
        config: runtimeConfig,
        close: async () => {
          closed.push("resources");
        },
      };
    },
  },
});
mock.module("@hackerspub/runtime/anonymous-read-admission", {
  namedExports: {
    anonymousReadLedgerKey,
    createMemoryAnonymousReadStore: () => store,
    createRedisAnonymousReadStore: async () => store,
  },
});
mock.module(new URL("../graphql/mod.ts", import.meta.url).href, {
  namedExports: {
    createYogaServer: () => {
      yogaCreated = true;
      return { dispose: async () => {} };
    },
  },
});
mock.module(new URL("../graphql/api.ts", import.meta.url).href, {
  namedExports: {
    createGraphqlApiHandler: (options: GraphqlApiHandlerOptions) => {
      handlerOptions = options;
      return async () => new Response();
    },
  },
});
mock.module(new URL("../graphql/node-http.ts", import.meta.url).href, {
  namedExports: {
    createNodeHttpServer: () => {
      transportCreated = true;
      return {
        server: {},
        listen: async () => {
          listening = true;
          return { address: "127.0.0.1", port: 12345 };
        },
        close: async () => {},
      };
    },
    waitForNodeHttpShutdown: async () => {
      assert.equal(handlerOptions?.ready?.(), true);
      if (role === "interactive") {
        // Capacity pressure is healthy; only known permanent store failure is not.
        assert.equal(await store.acquire(), false);
        assert.equal(handlerOptions?.ready?.(), true);
        store.failure = "redis_disconnected";
        assert.equal(handlerOptions?.ready?.(), false);
        store.failure = undefined;
      }
      process.emit("SIGTERM");
      assert.equal(handlerOptions?.ready?.(), false);
    },
  },
});
const { main } = await import("../graphql/main.ts");
const signals = ["SIGINT", "SIGTERM"] as const;
const signalListeners = signals.map((signal) => process.listeners(signal));
const intervals = new Set<ReturnType<typeof setInterval>>();
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
mock.method(
  globalThis,
  "setInterval",
  (...args: Parameters<typeof setInterval>) => {
    const timer = originalSetInterval(...args);
    intervals.add(timer);
    return timer;
  },
);
mock.method(
  globalThis,
  "clearInterval",
  (timer: ReturnType<typeof setInterval>) => {
    intervals.delete(timer);
    originalClearInterval(timer);
  },
);
if (startupFailure != null) {
  await assert.rejects(main(role), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(startupFailure), error.message);
    assert.ok(
      error.message.includes(
        anonymousReadLedgerKey(new URL("https://fixture.example")),
      ),
      error.message,
    );
    assert.match(error.message, /\b8\b/);
    assert.match(error.message, /DEPLOYMENT\.md/);
    if (startupFailure === "ledger_missing_or_mismatched") {
      assert.match(error.message, /Drain all API replicas before repairing/);
      assert.ok(!error.message.includes("retry only this failed replica"));
    } else {
      assert.match(
        error.message,
        /Check Redis connectivity and ledger metadata/,
      );
      assert.match(
        error.message,
        /If acknowledged ownership state is intact, retry only this failed replica/,
      );
      assert.match(
        error.message,
        /metadata repair or suspected Redis state loss/,
      );
    }
    return true;
  });
  assert.equal(yogaCreated, false);
  assert.equal(handlerOptions, undefined);
  assert.equal(transportCreated, false);
  assert.equal(listening, false);
  assert.deepEqual(closed, ["store", "resources"]);
} else {
  await main(role);
  assert.equal(handlerOptions?.role, role);
}
for (const [index, signal] of signals.entries()) {
  assert.deepEqual(process.listeners(signal), signalListeners[index]);
}
assert.equal(intervals.size, 0, "main must clear its reporting timers");
mock.restoreAll();
if (startupFailure == null) {
  assert.equal(handlerOptions?.role, role);
  assert.equal(capturedOptions?.federation?.manuallyStartQueue, true);
  if (role === "protocol") {
    assert.deepEqual(capturedConfig?.database.protocolWork, {
      limit: 7,
      timeoutMs: 333,
    });
    assert.deepEqual(capturedOptions?.federation?.protocolHttp, {
      loaderLimit: 3,
      loaderTimeoutMs: 222,
    });
    assert.equal(
      capturedConfig?.database.applicationName,
      "hackerspub-protocol",
    );
    assert.equal(handlerOptions?.yogaServer, undefined);
    assert.ok(handlerOptions?.protocolAdmission);
  } else {
    assert.equal(capturedConfig?.database.protocolWork, undefined);
    assert.equal(capturedOptions?.federation?.protocolHttp, undefined);
    assert.ok(handlerOptions?.yogaServer);
  }
}
