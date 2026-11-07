import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Build first. This fixture uses the emitted RPC serializer and Solid context,
// exercising the deployed module copies rather than a source-only substitute.
const webDirectory = fileURLToPath(new URL("../web-next/", import.meta.url));
const output = `${webDirectory}.output/server/`;
const marker = "SSR_GRAPHQL_SMOKE_HEALTHY";
const stop = new AbortController();
const onStop = () => stop.abort(new Error("Smoke interrupted"));
process.once("SIGINT", onStop);
process.once("SIGTERM", onStop);

async function bounded<T>(
  work: Promise<T>,
  label: string,
  milliseconds = 5000,
  cleanup = false,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          milliseconds,
        );
        if (!cleanup) {
          abort = () => reject(stop.signal.reason);
          if (stop.signal.aborted) abort();
          else stop.signal.addEventListener("abort", abort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort != null) stop.signal.removeEventListener("abort", abort);
  }
}

interface Call {
  operation: string;
  closed: Promise<void>;
  response: ServerResponse;
}
interface Scenario {
  mode: "healthy" | "headers" | "body" | "trickle" | "slow";
  calls: Call[];
  first: ReturnType<typeof Promise.withResolvers<Call>>;
}
const scenarios = new Map<string, Scenario>();
function scenario(label: string, mode: Scenario["mode"]): Scenario {
  const value = { mode, calls: [], first: Promise.withResolvers<Call>() };
  scenarios.set(label, value);
  return value;
}
const api = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const query = (JSON.parse(body) as { query: string }).query;
    const operation =
      query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unnamed";
    const fixture = scenarios.get(request.headers["user-agent"] ?? "");
    assert.ok(fixture, "Upstream request must belong to this smoke fixture");
    const closed = Promise.withResolvers<void>();
    const call = { operation, closed: closed.promise, response };
    fixture.calls.push(call);
    fixture.first.resolve(call);
    let timer:
      | ReturnType<typeof setTimeout>
      | ReturnType<typeof setInterval>
      | undefined;
    response.once("close", () => {
      clearTimeout(timer);
      clearInterval(timer);
      closed.resolve();
    });
    const finish = () => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            viewer: null,
            webPushVapidPublicKey: null,
            codeOfConduct: {
              title: "Smoke fixture",
              html: `<p>${marker}</p>`,
              toc: [],
            },
          },
        }),
      );
    };
    if (fixture.mode === "healthy") finish();
    else if (fixture.mode === "slow")
      timer = setTimeout(
        finish,
        operation.startsWith("Sequential") ? 150 : 650,
      );
    else if (fixture.mode !== "headers") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("{");
      if (fixture.mode === "trickle")
        timer = setInterval(() => response.write(" "), 30);
    }
  } catch {
    response.destroy();
  }
});

interface Subscription {
  unsubscribe(): void;
}
interface Observer {
  next?(value: unknown): void;
  error?(error: Error): void;
  complete?(): void;
}
interface Environment {
  getNetwork(): {
    execute(
      params: object,
      variables: object,
      cacheConfig: object,
    ): {
      subscribe(observer: Observer): Subscription;
    };
  };
}
type RequestEvent = { request: Request; locals: object };
type ProvideEvent = <T>(event: RequestEvent, callback: () => T) => T;
const params = (name: string, kind = "query") => ({
  cacheID: name,
  id: null,
  name,
  operationKind: kind,
  text: `${kind} ${name} { __typename }`,
  metadata: {},
});
const originalEnvironment = { ...process.env };
let child: ReturnType<typeof spawn> | undefined;
let childExit: Promise<void> | undefined;
const portLease = createServer();
let logs = "";
let checks = 0;

try {
  const entryPath = `${output}chunks/_/entry-server.mjs`;
  const entryText = await bounded(
    readFile(entryPath, "utf8"),
    "read built entry (run build:web-next first)",
  );
  const rpcId = entryText.match(
    /"([^"]+)":\s*\{\s*functionName: "fetchFn_1"/,
  )?.[1];
  const environmentAlias = entryText.match(
    /\bcreateEnvironment as ([\w$]+)/,
  )?.[1];
  assert.ok(
    rpcId && environmentAlias,
    "Built manifest must export Relay RPC and environment factory",
  );
  await bounded(
    new Promise<void>((resolve, reject) => {
      api.once("error", reject);
      api.listen(0, "127.0.0.1", resolve);
    }),
    "start fake API",
  );
  const apiAddress = api.address();
  assert.ok(apiAddress && typeof apiAddress !== "string");
  await bounded(
    new Promise<void>((resolve, reject) => {
      portLease.once("error", reject);
      portLease.listen(0, "127.0.0.1", resolve);
    }),
    "allocate isolated web port",
  );
  const address = portLease.address();
  assert.ok(address && typeof address !== "string");
  await bounded(
    new Promise<void>((resolve, reject) =>
      portLease.close((error) => (error ? reject(error) : resolve())),
    ),
    "release web port",
  );
  const origin = `http://127.0.0.1:${address.port}`;
  const environment = {
    HOST: "127.0.0.1",
    PORT: String(address.port),
    ORIGIN: origin,
    API_URL: `http://127.0.0.1:${apiAddress.port}/graphql`,
    SENTRY_DSN: "",
    BEHIND_PROXY: "false",
    WEB_SSR_GRAPHQL_TIMEOUT_MS: "200",
    WEB_SSR_GRAPHQL_BUDGET_MS: "400",
    WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS: "1000",
  };
  Object.assign(process.env, environment);
  const ready = Promise.withResolvers<void>();
  child = spawn(process.execPath, [`${output}index.mjs`], {
    cwd: webDirectory,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childExit = new Promise<void>((resolve) => {
    child!.once("error", (error) => {
      ready.reject(error);
      resolve();
    });
    child!.once("close", () => {
      ready.reject(new Error("Built server exited before readiness"));
      resolve();
    });
  });
  const collect = (chunk: Buffer) => {
    logs = (logs + chunk).slice(-100_000);
    if (logs.includes("Listening")) ready.resolve();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  await bounded(ready.promise, "built server readiness", 15000);
  const emittedImport = (path: string) =>
    bounded(
      import(pathToFileURL(`${output}${path}`).href),
      `import emitted ${path}`,
    );
  const entry = await emittedImport("chunks/_/entry-server.mjs");
  const createEnvironment = entry[environmentAlias] as () => Environment;
  const { provideRequestEvent } = (await emittedImport(
    "node_modules/solid-js/web/storage/dist/storage.js",
  )) as { provideRequestEvent: ProvideEvent };
  const { toJSON } = (await emittedImport(
    "node_modules/seroval/dist/esm/production/index.mjs",
  )) as { toJSON(value: unknown): unknown };
  const requestEvent = (
    label: string,
    inbound = new AbortController(),
  ): RequestEvent => ({
    request: new Request(`${origin}/coc`, {
      headers: { "user-agent": label },
      signal: inbound.signal,
    }),
    locals: {},
  });
  const execute = (event: RequestEvent, name: string, observer: Observer) =>
    provideRequestEvent(event, () =>
      createEnvironment()
        .getNetwork()
        .execute(params(name), {}, {})
        .subscribe(observer),
    );
  const result = (event: RequestEvent, name: string) =>
    new Promise<void>((resolve, reject) =>
      execute(event, name, { error: reject, complete: resolve }),
    );
  const page = async (label: string, signal = AbortSignal.timeout(5000)) => {
    const response = await fetch(`${origin}/coc`, {
      headers: { "user-agent": label },
      signal,
    });
    return await response.text();
  };
  const rpc = async (
    label: string,
    kind = "query",
    signal = AbortSignal.timeout(5000),
  ) => {
    const response = await fetch(`${origin}/_server`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Id": rpcId,
        "X-Server-Instance": "smoke:1",
        "user-agent": label,
      },
      body: JSON.stringify(toJSON([params(label, kind), {}])),
      signal,
    });
    await response.text();
    return response;
  };
  const closed = async (fixture: Scenario, milliseconds = 5000) => {
    assert.ok(fixture.calls.length);
    await bounded(
      Promise.all(fixture.calls.map((call) => call.closed)),
      `upstream response closure (${fixture.calls.map((call) => call.operation).join(", ")})`,
      milliseconds,
    );
  };
  const passed = (label: string) => {
    checks++;
    console.log(`PASS ${label}`);
  };

  async function inspectBrowser(directory: string): Promise<void> {
    for (const file of await bounded(
      readdir(directory, { withFileTypes: true }),
      "read browser artifacts",
    )) {
      const path = `${directory}/${file.name}`;
      if (file.isDirectory()) await inspectBrowser(path);
      else if (file.name.endsWith(".js") || file.name.endsWith(".mjs")) {
        const code = await bounded(
          readFile(path, "utf8"),
          "inspect browser JavaScript",
        );
        assert.doesNotMatch(
          code,
          /WEB_SSR_GRAPHQL_TIMEOUT_MS|WEB_SSR_GRAPHQL_BUDGET_MS|WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS|relayTransport\.server|createGraphQLRequestLifetime|createNodeRequestLifetime|fingerprintSessionId|\bAPI_URL\b/,
        );
      }
    }
  }
  await inspectBrowser(`${webDirectory}.output/public/_build`);
  passed("browser JavaScript excludes server transport and runtime settings");

  scenario("healthy-page", "healthy");
  assert.ok(
    (await bounded(page("healthy-page"), "healthy page")).includes(marker),
  );
  passed("built /coc healthy marker");
  for (const mode of ["headers", "body", "trickle"] as const) {
    const direct = scenario(`Direct${mode}`, mode);
    const started = performance.now();
    await assert.rejects(
      bounded(
        result(requestEvent(`Direct${mode}`), `Direct${mode}`),
        "SSR deadline",
      ),
      { name: "TimeoutError" },
    );
    await closed(direct);
    assert.ok(
      performance.now() - started < 1500,
      "SSR deadline must cancel within the configured budget plus tolerance",
    );
    assert.equal(direct.calls.length, 1);
    assert.equal(direct.calls[0].response.writableEnded, false);
    const fixture = scenario(`Page${mode}`, mode);
    assert.equal(
      (await bounded(page(`Page${mode}`), "stalled page settlement")).includes(
        marker,
      ),
      false,
    );
    await closed(fixture);
    assert.ok(fixture.calls.every((call) => !call.response.writableEnded));
    assert.equal(
      new Set(fixture.calls.map((call) => call.operation)).size,
      fixture.calls.length,
    );
    passed(
      `SSR ${mode} timeout, page settlement, upstream closure and no retry`,
    );
  }

  const sequential = scenario("sequential", "slow");
  const event = requestEvent("sequential");
  await bounded(result(event, "SequentialOne"), "first sequential query");
  await bounded(result(event, "SequentialTwo"), "second sequential query");
  await assert.rejects(
    bounded(result(event, "SequentialThree"), "remaining page budget"),
    /page budget/,
  );
  const count = sequential.calls.length;
  await assert.rejects(
    bounded(result(event, "SequentialFour"), "expired page budget"),
    /page budget/,
  );
  assert.equal(sequential.calls.length, count);
  await closed(sequential);
  passed(
    "sequential actual SSR environment shares outer budget and fails before dispatch",
  );

  for (const mode of ["headers", "body"] as const) {
    const label = `Dispose${mode}`;
    const fixture = scenario(label, mode);
    const inbound = new AbortController();
    const callbacks: string[] = [];
    const failures: unknown[][] = [];
    const originalError = console.error;
    const originalFetch = globalThis.fetch;
    const headersReceived = Promise.withResolvers<void>();
    const watched: { signal?: AbortSignal | null } = {};
    let subscription: Subscription | undefined;
    try {
      // Make cancellation observable separately from eventual deadline expiry.
      process.env.WEB_SSR_GRAPHQL_TIMEOUT_MS = "5000";
      process.env.WEB_SSR_GRAPHQL_BUDGET_MS = "5000";
      globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
        watched.signal = args[1]?.signal;
        const response = await originalFetch(...args);
        headersReceived.resolve();
        return response;
      };
      console.error = (...args: unknown[]) => {
        failures.push(args);
      };
      subscription = execute(requestEvent(label, inbound), label, {
        next: () => callbacks.push("next"),
        error: () => callbacks.push("error"),
        complete: () => callbacks.push("complete"),
      });
      await bounded(fixture.first.promise, "disposal upstream start");
      if (mode === "body")
        await bounded(
          headersReceived.promise,
          "actual upstream response headers before disposal",
        );
      const disposed = performance.now();
      subscription.unsubscribe();
      await closed(fixture, 1000);
      assert.ok(
        performance.now() - disposed < 1000,
        "Disposal must close upstream well before its 5000ms deadline",
      );
      assert.ok(watched.signal?.aborted);
      assert.equal(watched.signal.reason.name, "GraphQLRequestCancelledError");
      assert.equal(watched.signal.reason.source, "disposal");
      await bounded(
        new Promise<void>((resolve) => setTimeout(resolve, 0)),
        "late rejection delivery",
      );
      assert.equal(inbound.signal.aborted, false);
      assert.deepEqual(callbacks, []);
      assert.deepEqual(failures, []);
      assert.equal(fixture.calls.length, 1);
    } finally {
      subscription?.unsubscribe();
      console.error = originalError;
      globalThis.fetch = originalFetch;
      process.env.WEB_SSR_GRAPHQL_TIMEOUT_MS =
        environment.WEB_SSR_GRAPHQL_TIMEOUT_MS;
      process.env.WEB_SSR_GRAPHQL_BUDGET_MS =
        environment.WEB_SSR_GRAPHQL_BUDGET_MS;
    }
    passed(
      `actual SSR disposal ${mode} keeps inbound open, closes upstream and stays quiet`,
    );
  }

  const aborting = scenario("aborted-page", "body");
  const inbound = new AbortController();
  const aborted = page("aborted-page", inbound.signal);
  const abortedResult = assert.rejects(aborted, { name: "AbortError" });
  await bounded(aborting.first.promise, "page to abort");
  scenario("concurrent-healthy", "healthy");
  const healthy = page("concurrent-healthy");
  const pageLogStart = logs.length;
  inbound.abort();
  await bounded(abortedResult, "cancel page");
  await closed(aborting, 150);
  assert.doesNotMatch(logs.slice(pageLogStart), /Unhandled Error|TimeoutError/);
  assert.ok(
    (await bounded(healthy, "unaffected concurrent page")).includes(marker),
  );
  scenario("recovered-page", "healthy");
  assert.ok(
    (await bounded(page("recovered-page"), "later recovery")).includes(marker),
  );
  passed(
    "HTTP disconnect isolation, concurrent healthy request and later recovery",
  );

  for (const kind of ["query", "mutation"]) {
    const label = `Interactive${kind}`;
    const fixture = scenario(label, "slow");
    const response = await bounded(
      rpc(label, kind),
      "long interactive success",
    );
    assert.equal(response.headers.get("X-Error"), null);
    assert.equal(response.status, 200);
    assert.equal(fixture.calls.length, 1);
    passed(`${kind} RPC outlives SSR budget without retry`);
  }
  const timeout = scenario("InteractiveTimeout", "body");
  const interactiveStarted = performance.now();
  const timeoutResponse = await bounded(
    rpc("InteractiveTimeout", "mutation"),
    "interactive upper bound",
  );
  assert.match(
    timeoutResponse.headers.get("X-Error") ?? "",
    /Interactive GraphQL operation deadline/,
  );
  await closed(timeout);
  assert.ok(
    performance.now() - interactiveStarted < 2500,
    "Interactive upper bound must remain finite",
  );
  assert.equal(timeout.calls.length, 1);
  const cancelled = scenario("InteractiveCancel", "body");
  const rpcAbort = new AbortController();
  const cancelledResult = assert.rejects(
    rpc("InteractiveCancel", "query", rpcAbort.signal),
    { name: "AbortError" },
  );
  await bounded(cancelled.first.promise, "interactive cancellation start");
  const logStart = logs.length;
  rpcAbort.abort();
  await bounded(cancelledResult, "cancel RPC");
  await closed(cancelled, 500);
  assert.equal(cancelled.calls.length, 1);
  assert.doesNotMatch(
    logs.slice(logStart),
    /Unhandled Error|GraphQLRequestCancelledError/,
  );
  passed("interactive upper bound, mutation no retry and quiet RPC disconnect");
  console.log(`SSR GraphQL smoke: ${checks} checks passed.`);
} finally {
  try {
    if (child != null && childExit != null) {
      child.kill("SIGTERM");
      try {
        await bounded(childExit, "server graceful shutdown", 3000, true);
      } catch {
        child.kill("SIGKILL");
        await bounded(childExit, "server forced shutdown", 3000, true);
      }
    }
  } finally {
    try {
      api.closeAllConnections();
      if (api.listening)
        await bounded(
          new Promise<void>((resolve, reject) =>
            api.close((error) => (error ? reject(error) : resolve())),
          ),
          "fake API shutdown",
          3000,
          true,
        );
    } finally {
      if (portLease.listening) portLease.close();
      for (const key of Object.keys(process.env))
        if (!(key in originalEnvironment)) delete process.env[key];
      Object.assign(process.env, originalEnvironment);
      process.removeListener("SIGINT", onStop);
      process.removeListener("SIGTERM", onStop);
    }
  }
}
