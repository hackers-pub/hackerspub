import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test, { type TestContext } from "node:test";
import * as Sentry from "@sentry/solidstart";
import type { GraphQLResponse, RequestParameters } from "relay-runtime";
import { Observable } from "relay-runtime";
import { provideRequestEvent } from "solid-js/web/storage";
import { GraphQLRequestCancelledError } from "./graphQLCancellation.ts";
import { createRelayResponseObservable } from "./relayResponse.ts";
import {
  fetchInteractiveGraphQL,
  fetchSsrGraphQL,
} from "./relayTransport.server.ts";
import { startSsrGraphQLBudget } from "./ssrGraphQLBudget.ts";
import { TransientUpstreamGraphQLError } from "./upstreamGraphQLError.ts";

const params: RequestParameters = {
  cacheID: "transport-fixture",
  id: null,
  metadata: {},
  name: "TransportFixture",
  operationKind: "query",
  text: "query TransportFixture { __typename }",
};
const data = { data: { __typename: "Query" } };

function configure(t: TestContext, values: Record<string, string> = {}) {
  const settings = {
    WEB_SSR_GRAPHQL_TIMEOUT_MS: "300",
    WEB_SSR_GRAPHQL_BUDGET_MS: "1000",
    WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS: "1000",
    ...values,
  };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

async function upstream(
  t: TestContext,
  respond: (
    request: IncomingMessage,
    response: ServerResponse,
    count: number,
  ) => void,
) {
  const received = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    response.once("close", () => closed.resolve());
    respond(request, response, count);
    received.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address != null && typeof address === "object");
  const previous = process.env.API_URL;
  process.env.API_URL = `http://127.0.0.1:${address.port}/graphql`;
  t.after(async () => {
    if (previous === undefined) delete process.env.API_URL;
    else process.env.API_URL = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    received: received.promise,
    closed: closed.promise,
    count: () => count,
  };
}

function requestContext(
  controller = new AbortController(),
): Parameters<typeof provideRequestEvent>[0] {
  // The transport only needs these Solid request fields, not a native H3 event.
  return {
    request: new Request("http://web.example/coc", {
      signal: controller.signal,
    }),
    locals: {},
  } as Parameters<typeof provideRequestEvent>[0];
}

function watchHeaders(t: TestContext): Promise<void> {
  const arrived = Promise.withResolvers<void>();
  const fetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (...args: Parameters<typeof fetch>) => {
      const response = await fetch(...args);
      arrived.resolve();
      return response;
    },
  );
  return arrived.promise;
}

for (const mode of ["headers", "body", "trickle"] as const) {
  test(
    `SSR deadline cancels ${mode} stalls and closes the upstream`,
    { timeout: 5000 },
    async (t) => {
      configure(t);
      const fixture = await upstream(t, (_request, response) => {
        if (mode === "headers") return;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"data":');
        if (mode === "trickle") {
          const timer = setInterval(() => response.write(" "), 15);
          response.once("close", () => clearInterval(timer));
        }
      });
      const started = performance.now();
      await assert.rejects(
        provideRequestEvent(
          requestContext(),
          (): Promise<GraphQLResponse> =>
            fetchSsrGraphQL(params, {}, new AbortController().signal),
        ),
        (error: Error) =>
          error.name === "TimeoutError" && /SSR GraphQL/.test(error.message),
      );
      await fixture.closed;
      assert(performance.now() - started < 2000);
      assert.equal(fixture.count(), 1);
    },
  );
}

for (const afterHeaders of [false, true]) {
  test(
    `SSR disposal cancels upstream ${afterHeaders ? "after" : "before"} headers with inbound open`,
    { timeout: 5000 },
    async (t) => {
      configure(t, {
        WEB_SSR_GRAPHQL_TIMEOUT_MS: "2000",
        WEB_SSR_GRAPHQL_BUDGET_MS: "3000",
      });
      const headers = watchHeaders(t);
      const fixture = await upstream(t, (_request, response) => {
        if (afterHeaders) {
          response.writeHead(200);
          response.write('{"data":');
        }
      });
      const inbound = new AbortController();
      const operation = new AbortController();
      const callbacks: string[] = [];
      const consoleErrors = t.mock.method(console, "error", () => {});
      const subscription = createRelayResponseObservable(
        provideRequestEvent(requestContext(inbound), () =>
          fetchSsrGraphQL(params, {}, operation.signal),
        ),
        operation,
      ).subscribe({
        next: () => callbacks.push("next"),
        complete: () => callbacks.push("complete"),
        error: () => callbacks.push("error"),
      });
      await (afterHeaders ? headers : fixture.received);
      subscription.unsubscribe();
      await fixture.closed;
      // Let the rejected fetch/body Promise finish its forwarding microtasks.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(inbound.signal.aborted, false);
      assert.equal(operation.signal.aborted, true);
      assert.deepEqual(callbacks, []);
      assert.equal(consoleErrors.mock.callCount(), 0);
      assert.equal(fixture.count(), 1);
    },
  );

  test(
    `inbound abort ${afterHeaders ? "after" : "before"} headers errors without triggering preload fallback`,
    { timeout: 5000 },
    async (t) => {
      configure(t, {
        WEB_SSR_GRAPHQL_TIMEOUT_MS: "2000",
        WEB_SSR_GRAPHQL_BUDGET_MS: "3000",
      });
      const headers = watchHeaders(t);
      const fixture = await upstream(t, (_request, response) => {
        if (afterHeaders) {
          response.writeHead(200);
          response.write('{"data":');
        }
      });
      const inbound = new AbortController();
      const operation = new AbortController();
      let fallbacks = 0;
      const observable = createRelayResponseObservable(
        provideRequestEvent(requestContext(inbound), () =>
          fetchSsrGraphQL(params, {}, operation.signal),
        ),
        operation,
      ).ifEmpty(
        Observable.create((sink) => {
          fallbacks++;
          sink.next(data);
          sink.complete();
        }),
      );
      const rejection = assert.rejects(
        observable.toPromise(),
        (error: unknown) => {
          assert(error instanceof GraphQLRequestCancelledError);
          assert.equal(error.source, "inbound");
          return true;
        },
      );
      await (afterHeaders ? headers : fixture.received);
      // Even a caller's TimeoutError is intentional, not our own deadline.
      inbound.abort(new DOMException("Caller stopped", "TimeoutError"));
      await rejection;
      await fixture.closed;
      assert.equal(fallbacks, 0);
      assert.equal(fixture.count(), 1);
      assert.equal(operation.signal.aborted, false);
    },
  );
}

test(
  "sequential SSR queries consume one page budget and exhausted pages do not dispatch",
  { timeout: 5000 },
  async (t) => {
    configure(t, {
      WEB_SSR_GRAPHQL_TIMEOUT_MS: "1000",
      WEB_SSR_GRAPHQL_BUDGET_MS: "250",
    });
    const fixture = await upstream(t, (_request, response, count) => {
      if (count === 1) {
        const timer = setTimeout(() => response.end(JSON.stringify(data)), 120);
        response.once("close", () => clearTimeout(timer));
      }
    });
    const event = requestContext();
    startSsrGraphQLBudget(event.locals);
    const started = performance.now();
    const run = () =>
      provideRequestEvent(event, () =>
        fetchSsrGraphQL(params, {}, new AbortController().signal),
      );
    assert.deepEqual(await run(), data);
    await assert.rejects(
      run(),
      (error: Error) =>
        error.name === "TimeoutError" && /page budget/.test(error.message),
    );
    assert(performance.now() - started < 800);
    await assert.rejects(run(), { name: "TimeoutError" });
    assert.equal(fixture.count(), 2);
  },
);

test(
  "concurrent SSR requests have isolated cancellation and later requests recover",
  { timeout: 5000 },
  async (t) => {
    configure(t, {
      WEB_SSR_GRAPHQL_TIMEOUT_MS: "1000",
      WEB_SSR_GRAPHQL_BUDGET_MS: "2000",
    });
    const fixture = await upstream(t, (_request, response, count) => {
      if (count > 1) response.end(JSON.stringify(data));
    });
    const aborted = new AbortController();
    const first = provideRequestEvent(requestContext(aborted), () =>
      fetchSsrGraphQL(params, {}, new AbortController().signal),
    );
    const rejected = assert.rejects(first, GraphQLRequestCancelledError);
    await fixture.received;
    const second = provideRequestEvent(
      requestContext(),
      (): Promise<GraphQLResponse> =>
        fetchSsrGraphQL(params, {}, new AbortController().signal),
    );
    aborted.abort("disconnected");
    await rejected;
    assert.deepEqual(await second, data);
    assert.deepEqual(
      await provideRequestEvent(
        requestContext(),
        (): Promise<GraphQLResponse> =>
          fetchSsrGraphQL(params, {}, new AbortController().signal),
      ),
      data,
    );
    assert.equal(fixture.count(), 3);
  },
);

test(
  "interactive queries and mutations use their longer, independently bounded policy",
  { timeout: 5000 },
  async (t) => {
    configure(t, {
      WEB_SSR_GRAPHQL_TIMEOUT_MS: "1",
      WEB_SSR_GRAPHQL_BUDGET_MS: "1",
      WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS: "300",
    });
    const fixture = await upstream(t, (_request, response, count) => {
      if (count < 3) {
        const timer = setTimeout(() => response.end(JSON.stringify(data)), 80);
        response.once("close", () => clearTimeout(timer));
      }
    });
    for (const operationKind of ["query", "mutation"] as const) {
      assert.deepEqual(
        await provideRequestEvent(
          requestContext(),
          (): Promise<GraphQLResponse> =>
            fetchInteractiveGraphQL({ ...params, operationKind }, {}),
        ),
        data,
      );
    }
    await assert.rejects(
      provideRequestEvent(
        requestContext(),
        (): Promise<GraphQLResponse> => fetchInteractiveGraphQL(params, {}),
      ),
      { name: "TimeoutError" },
    );
    assert.equal(fixture.count(), 3);
  },
);

test(
  "HTTP, JSON and network failures preserve their existing behavior",
  { timeout: 5000 },
  async (t) => {
    configure(t);
    const cases = [
      { status: 502, text: "", error: TransientUpstreamGraphQLError },
      { status: 500, text: "upstream failed", error: Error },
      { status: 200, text: "{", error: SyntaxError },
      {
        status: 503,
        text: JSON.stringify({ errors: [{ message: "Unavailable" }] }),
      },
    ];
    let index = 0;
    const fixture = await upstream(t, (_request, response) => {
      const item = cases[index++];
      if (item == null) {
        response.destroy();
        return;
      }
      response.writeHead(item.status);
      response.end(item.text);
    });
    for (const item of cases) {
      const result = provideRequestEvent(
        requestContext(),
        (): Promise<GraphQLResponse> =>
          fetchSsrGraphQL(params, {}, new AbortController().signal),
      );
      if (item.error != null) await assert.rejects(result, item.error);
      else assert.deepEqual(await result, JSON.parse(item.text));
    }
    await assert.rejects(
      provideRequestEvent(
        requestContext(),
        (): Promise<GraphQLResponse> =>
          fetchSsrGraphQL(params, {}, new AbortController().signal),
      ),
      TypeError,
    );
    assert.equal(fixture.count(), cases.length + 1);
  },
);

test(
  "transport captures owned timeouts but keeps deliberate inbound cancellation quiet",
  { timeout: 5000 },
  async (t) => {
    configure(t);
    const events: Sentry.Event[] = [];
    Sentry.init({
      dsn: "http://public@localhost/1",
      defaultIntegrations: false,
      beforeSend(event) {
        events.push(event);
        return null;
      },
    });
    t.after(() => Sentry.close(1000));
    await upstream(t, () => {});
    await assert.rejects(
      provideRequestEvent(
        requestContext(),
        (): Promise<GraphQLResponse> =>
          fetchSsrGraphQL(params, {}, new AbortController().signal),
      ),
      { name: "TimeoutError" },
    );
    await Sentry.flush(1000);
    assert.equal(events.length, 1);
    assert.equal(events[0].exception?.values?.at(-1)?.type, "TimeoutError");
    const inbound = new AbortController();
    inbound.abort(new Error("Client disconnected"));
    await assert.rejects(
      provideRequestEvent(requestContext(inbound), () =>
        fetchSsrGraphQL(params, {}, new AbortController().signal),
      ),
      GraphQLRequestCancelledError,
    );
    await Sentry.flush(1000);
    assert.equal(events.length, 1);
  },
);
