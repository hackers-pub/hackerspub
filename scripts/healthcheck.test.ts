import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { withProcessEnv } from "../test/env.ts";
import {
  checkGraphqlApi,
  checkWebNext,
  checkWorkerHealth,
  isHealthCheckRole,
  main,
} from "./healthcheck.ts";

interface StubResponse {
  readonly status?: number;
  readonly body?: unknown;
}

async function serve(
  respond: (method: string, url: string) => StubResponse,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const { status = 200, body = {} } = respond(
      request.method ?? "GET",
      request.url ?? "/",
    );
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("The stub server did not bind to a TCP port.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error == null ? resolve() : reject(error)));
      }),
  };
}

async function withTemporaryDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hackerspub-healthcheck-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("isHealthCheckRole accepts only the deployable roles", () => {
  assert.ok(isHealthCheckRole("graphql"));
  assert.ok(isHealthCheckRole("graphql-worker"));
  assert.ok(isHealthCheckRole("web-next"));
  assert.ok(!isHealthCheckRole("worker"));
  assert.ok(!isHealthCheckRole(""));
});

test("checkGraphqlApi accepts a schema that answers __typename", async () => {
  const { origin, close } = await serve(() => ({
    body: { data: { __typename: "Query" } },
  }));
  try {
    assert.deepEqual(await checkGraphqlApi(`${origin}/graphql`), true);
  } finally {
    await close();
  }
});

test("checkGraphqlApi rejects a GraphQL error payload", async () => {
  const { origin, close } = await serve(() => ({
    body: { errors: [{ message: "schema failed to build" }] },
  }));
  try {
    assert.deepEqual(await checkGraphqlApi(`${origin}/graphql`), false);
  } finally {
    await close();
  }
});

test("checkGraphqlApi rejects an unexpected __typename", async () => {
  const { origin, close } = await serve(() => ({
    body: { data: { __typename: "Mutation" } },
  }));
  try {
    assert.deepEqual(await checkGraphqlApi(`${origin}/graphql`), false);
  } finally {
    await close();
  }
});

test("checkGraphqlApi rejects a failing HTTP status", async () => {
  const { origin, close } = await serve(() => ({
    status: 503,
    body: { data: { __typename: "Query" } },
  }));
  try {
    assert.deepEqual(await checkGraphqlApi(`${origin}/graphql`), false);
  } finally {
    await close();
  }
});

test("checkWebNext follows the HTTP status of the rendered route", async () => {
  const healthy = await serve(() => ({}));
  try {
    assert.deepEqual(await checkWebNext(`${healthy.origin}/search`), true);
  } finally {
    await healthy.close();
  }
  const unhealthy = await serve(() => ({ status: 500 }));
  try {
    assert.deepEqual(await checkWebNext(`${unhealthy.origin}/search`), false);
  } finally {
    await unhealthy.close();
  }
});

test("checkWorkerHealth rejects a missing heartbeat file", async () => {
  await withTemporaryDirectory(async (directory) => {
    assert.deepEqual(
      await checkWorkerHealth(join(directory, "absent.health")),
      false,
    );
  });
});

test("checkWorkerHealth accepts a fresh heartbeat and rejects a stale one", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "worker.health");
    await writeFile(path, String(Date.now()));
    assert.deepEqual(await checkWorkerHealth(path), true);
    await writeFile(path, String(Date.now() - 600_000));
    assert.deepEqual(await checkWorkerHealth(path), false);
  });
});

test("main rejects an unknown or missing role without probing", async () => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = 0;
    await main([]);
    assert.deepEqual(process.exitCode, 1);

    process.exitCode = 0;
    await main(["worker"]);
    assert.deepEqual(process.exitCode, 1);

    process.exitCode = 0;
    await main(["graphql", "web-next"]);
    assert.deepEqual(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("main resolves the worker heartbeat from the environment", async () => {
  const previousExitCode = process.exitCode;
  try {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "worker.health");
      await withProcessEnv({ WORKER_HEALTH_FILE: path }, async () => {
        await writeFile(path, String(Date.now()));
        process.exitCode = 0;
        await main(["graphql-worker"]);
        assert.deepEqual(process.exitCode, 0);

        await rm(path);
        process.exitCode = 0;
        await main(["graphql-worker"]);
        assert.deepEqual(process.exitCode, 1);
      });
    });
  } finally {
    process.exitCode = previousExitCode;
  }
});
