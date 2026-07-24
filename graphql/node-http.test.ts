import assert from "node:assert/strict";
import { request as requestHttp } from "node:http";
import test from "node:test";
import type { GraphqlApiHandler } from "./api.ts";
import { createNodeHttpServer, getNodeConnectionInfo } from "./node-http.ts";
import { applyTrustedForwarding } from "./trusted-forwarding.ts";

function loopbackUrl(port: number, pathname = "/graphql"): URL {
  return new URL(pathname, `http://127.0.0.1:${port}`);
}

async function waitWithTimeout(
  promise: Promise<void>,
  milliseconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The operation did not finish in time.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

test("the Node adapter streams request and response bodies", async () => {
  let connectionHostname: string | undefined;
  let requestAborted: boolean | undefined;
  const handler: GraphqlApiHandler = async (request, connectionInfo) => {
    connectionHostname = connectionInfo.remoteAddr.hostname;
    requestAborted = request.signal.aborted;
    assert.equal(request.method, "POST");
    assert.equal(await request.text(), "request-body");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("response-"));
        controller.enqueue(new TextEncoder().encode("body"));
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/plain" },
    });
  };
  const api = createNodeHttpServer(handler);
  const address = await api.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(loopbackUrl(address.port), {
      method: "POST",
      body: "request-body",
    });
    assert.equal(await response.text(), "response-body");
    assert.equal(connectionHostname, "127.0.0.1");
    assert.equal(requestAborted, false);
  } finally {
    await api.close();
  }
});

test("the Node adapter preserves JSON bodies through trusted forwarding", async () => {
  const handler: GraphqlApiHandler = async (request, connectionInfo) => {
    const forwarded = await applyTrustedForwarding(
      request,
      connectionInfo,
      true,
    );
    return Response.json(await forwarded.request.json());
  };
  const api = createNodeHttpServer(handler);
  const address = await api.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(loopbackUrl(address.port), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "public.example",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { query: "{ __typename }" });
  } finally {
    await api.close();
  }
});

test("the Node adapter captures failures once and returns a generic 500", async () => {
  const captured: unknown[] = [];
  const warnings: unknown[] = [];
  const expected = new Error("private implementation detail");
  const api = createNodeHttpServer(
    async () => {
      throw expected;
    },
    {
      captureException(error) {
        captured.push(error);
      },
      logger: {
        warning(_message, properties) {
          warnings.push(properties.error);
        },
      },
    },
  );
  const address = await api.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(loopbackUrl(address.port));
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "Internal Server Error");
    assert.deepEqual(captured, [expected]);
    assert.deepEqual(warnings, [expected]);
  } finally {
    await api.close();
  }
});

test("disconnecting a Node client aborts the Fetch request signal", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const handler: GraphqlApiHandler = async (request) => {
    entered.resolve();
    if (!request.signal.aborted) {
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    }
    aborted.resolve();
    return new Response(null, { status: 499 });
  };
  const api = createNodeHttpServer(handler);
  const address = await api.listen({ hostname: "127.0.0.1", port: 0 });
  const request = requestHttp(loopbackUrl(address.port), {
    method: "POST",
    headers: { "content-length": "4" },
  });
  request.on("error", () => {});
  try {
    request.end("body");
    await entered.promise;
    request.destroy();
    await waitWithTimeout(aborted.promise, 1_000);
  } finally {
    request.destroy();
    await api.close();
  }
});

test("graceful close drains an in-flight response", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const handler: GraphqlApiHandler = async () => {
    entered.resolve();
    await release.promise;
    return new Response("done");
  };
  const api = createNodeHttpServer(handler);
  const address = await api.listen({ hostname: "127.0.0.1", port: 0 });
  const response = fetch(loopbackUrl(address.port), {
    headers: { connection: "close" },
  });
  await entered.promise;
  let closed = false;
  const closing = api.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  release.resolve();
  assert.equal(await (await response).text(), "done");
  await closing;
  assert.equal(closed, true);
});

test(
  "graceful close force-closes a request after its drain deadline",
  { skip: "Deno" in globalThis },
  async () => {
    const entered = Promise.withResolvers<void>();
    const warnings: unknown[] = [];
    const handler: GraphqlApiHandler = async () => {
      entered.resolve();
      await new Promise(() => {});
      return new Response("unreachable");
    };
    const api = createNodeHttpServer(handler, {
      drainTimeout: 20,
      logger: {
        warning(_message, properties) {
          warnings.push(properties.error);
        },
      },
    });
    const address = await api.listen({ hostname: "127.0.0.1", port: 0 });
    const disconnected = Promise.withResolvers<void>();
    const request = requestHttp(loopbackUrl(address.port));
    request.on("error", () => {});
    request.once("close", () => disconnected.resolve());
    request.end();
    await entered.promise;

    await waitWithTimeout(api.close(), 1_000);
    await waitWithTimeout(disconnected.promise, 1_000);
    assert.equal(warnings.length, 1);
    assert(warnings[0] instanceof Error);
  },
);

test("Node connection metadata normalizes IPv4-mapped addresses", () => {
  assert.deepEqual(
    getNodeConnectionInfo({
      socket: {
        remoteAddress: "::ffff:203.0.113.4",
        remotePort: 43210,
      },
    }),
    {
      remoteAddr: {
        transport: "tcp",
        hostname: "203.0.113.4",
        port: 43210,
      },
    },
  );
});
