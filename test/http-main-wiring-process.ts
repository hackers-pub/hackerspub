/** Isolated composition test: resources/transport are replaced, main is real. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as config from "../runtime/config.ts";
import type { GraphqlApiHandlerOptions } from "../graphql/api.ts";
import type { createRuntimeResources } from "../runtime/resources.ts";

const role = process.argv[2] as "interactive" | "protocol";
assert.ok(role === "interactive" || role === "protocol");
process.env.HTTP_ROLE = role;
process.env.PROTOCOL_SQL_LIMIT = "7";
process.env.PROTOCOL_SQL_TIMEOUT_MS = "333";
process.env.PROTOCOL_LOADER_LIMIT = "3";
process.env.PROTOCOL_LOADER_TIMEOUT_MS = "222";
let capturedConfig: Parameters<typeof createRuntimeResources>[0] | undefined;
let capturedOptions: Parameters<typeof createRuntimeResources>[2] | undefined;
let handlerOptions: GraphqlApiHandlerOptions | undefined;
const store = {
  failure: undefined as string | undefined,
  acquire: async () => false,
  release: async () => {},
  close: async () => {},
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
      return { config: runtimeConfig, close: async () => {} };
    },
  },
});
mock.module("@hackerspub/runtime/anonymous-read-admission", {
  namedExports: {
    createMemoryAnonymousReadStore: () => store,
    createRedisAnonymousReadStore: async () => store,
  },
});
mock.module(new URL("../graphql/mod.ts", import.meta.url).href, {
  namedExports: {
    createYogaServer: () => ({ dispose: async () => {} }),
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
    createNodeHttpServer: () => ({
      server: {},
      listen: async () => ({ address: "127.0.0.1", port: 12345 }),
      close: async () => {},
    }),
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
await main(role);
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
  assert.equal(capturedConfig?.database.applicationName, "hackerspub-protocol");
  assert.equal(handlerOptions?.yogaServer, undefined);
  assert.ok(handlerOptions?.protocolAdmission);
} else {
  assert.equal(capturedConfig?.database.protocolWork, undefined);
  assert.equal(capturedOptions?.federation?.protocolHttp, undefined);
  assert.ok(handlerOptions?.yogaServer);
}
