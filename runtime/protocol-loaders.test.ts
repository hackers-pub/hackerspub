import {
  createFederationBuilder,
  FetchError,
  generateCryptoKeyPair,
  type KvKey,
  type KvStoreSetOptions,
  MemoryKvStore,
} from "@fedify/fedify";
import {
  getRequestWorkOutcome,
  reportRequestDependencyInterruption,
  reportRequestWorkFailure,
  runWithRequestWork,
} from "@hackerspub/models/request-work";
import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createProtocolKvStore,
  createProtocolLoaders,
} from "./protocol-loaders.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address != null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("real Fedify callback merges generated origin with software and preserves document/context caching", async () => {
  const headers: string[] = [];
  const server = createServer((request, response) => {
    headers.push(request.headers["user-agent"] ?? "");
    response.setHeader("content-type", "application/activity+json");
    response.end(JSON.stringify({ id: request.url }));
  });
  const origin = await listen(server);
  const kv = new MemoryKvStore();
  const writes: { key: KvKey; options?: KvStoreSetOptions }[] = [];
  const set = kv.set.bind(kv);
  kv.set = async (key, value, options) => {
    writes.push({ key, options });
    await set(key, value, options);
  };
  const loaders = createProtocolLoaders({
    kv,
    userAgent: { software: "HackersPub/test" },
    limit: 8,
    timeoutMs: 5000,
  });
  // Private address access belongs only to this local HTTP test fixture.
  const federation = await createFederationBuilder<void>().build({
    kv,
    ...loaders.options,
    documentLoaderFactory: (options) =>
      loaders.options.documentLoaderFactory({
        ...options,
        allowPrivateAddress: true,
      }),
    contextLoaderFactory: (options) =>
      loaders.options.contextLoaderFactory({
        ...options,
        allowPrivateAddress: true,
      }),
  });
  try {
    const context = federation.createContext(
      new Request("https://local.example/ap/actors/test"),
      undefined,
    );
    const first = await context.documentLoader(`${origin}/document`);
    assert.deepEqual(await context.documentLoader(`${origin}/document`), first);
    assert.deepEqual(await context.contextLoader(`${origin}/document`), first);
    await context.contextLoader("https://www.w3.org/ns/activitystreams");
    assert.equal(headers.length, 1);
    assert.match(headers[0], /HackersPub\/test/);
    assert.match(headers[0], /https:\/\/local\.example/);
    assert.equal(writes[0]?.options?.ttl?.total("minutes"), 5);
    assert.equal(loaders.stats().active, 0);
    const explicit = createProtocolLoaders({
      kv: new MemoryKvStore(),
      userAgent: "Configured/test",
      limit: 1,
      timeoutMs: 5000,
    });
    await explicit.options.documentLoaderFactory({
      allowPrivateAddress: true,
      userAgent: "Caller/test",
    })(`${origin}/explicit`);
    assert.equal(headers.at(-1), "Caller/test");
  } finally {
    await close(server);
  }
});

test("authenticated requests stay uncached and remember the negotiated signing spec for 90 days", async () => {
  const signatures: { signature?: string; input?: string }[] = [];
  const server = createServer((request, response) => {
    signatures.push({
      signature: request.headers.signature as string | undefined,
      input: request.headers["signature-input"] as string | undefined,
    });
    response.setHeader("content-type", "application/activity+json");
    response.end(JSON.stringify({ private: true }));
  });
  const origin = await listen(server);
  const kv = new MemoryKvStore();
  const writes: { key: KvKey; options?: KvStoreSetOptions }[] = [];
  const set = kv.set.bind(kv);
  kv.set = async (key, value, options) => {
    writes.push({ key, options });
    await set(key, value, options);
  };
  const loaders = createProtocolLoaders({
    kv,
    firstKnock: "draft-cavage-http-signatures-12",
    limit: 8,
    timeoutMs: 5000,
  });
  const keys = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
  const loader = loaders.options.authenticatedDocumentLoaderFactory(
    {
      keyId: new URL("https://local.example/actor#key"),
      privateKey: keys.privateKey,
    },
    { allowPrivateAddress: true },
  );
  try {
    await loader(`${origin}/private`);
    assert.match(signatures[0]?.signature ?? "", /keyId=/);
    assert.equal(signatures[0]?.input, undefined);
    const specKey: KvKey = ["_fedify", "httpMessageSignaturesSpec", origin];
    assert.equal(await kv.get(specKey), "draft-cavage-http-signatures-12");
    assert.equal(writes[0]?.options?.ttl?.total("days"), 90);
    await kv.set(specKey, "rfc9421");
    await loader(`${origin}/private`);
    assert.equal(signatures.length, 2);
    assert.match(signatures[1]?.input ?? "", /sig\d*=/);
    assert.equal(
      await kv.get(["_fedify", "remoteDocument", `${origin}/private`]),
      undefined,
    );
  } finally {
    await close(server);
  }
});

test("SSRF defaults still reject loopback targets", async () => {
  const loaders = createProtocolLoaders({
    kv: new MemoryKvStore(),
    limit: 8,
    timeoutMs: 5000,
  });
  await assert.rejects(
    loaders.options.documentLoaderFactory()("http://127.0.0.1/private"),
  );
  assert.deepEqual(loaders.stats(), {
    active: 0,
    limit: 8,
    rejected: 0,
    timedOut: 0,
  });
});

test("all three factories share a budget including uncooperative cache reads", async () => {
  const pending = deferred<unknown>();
  const started = deferred<void>();
  const kv = new MemoryKvStore();
  kv.get = async <T>() => {
    started.resolve();
    return (await pending.promise) as T;
  };
  const loaders = createProtocolLoaders({ kv, limit: 1, timeoutMs: 15 });
  const keys = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
  const authenticated = loaders.options.authenticatedDocumentLoaderFactory({
    keyId: new URL("https://local.example/actor#key"),
    privateKey: keys.privateKey,
  });
  const scope = new AbortController();
  let finished = false;
  const work = runWithRequestWork(scope.signal, async () => {
    const promise = loaders.options.documentLoaderFactory()(
      "https://remote.example/actor",
    );
    await started.promise;
    await delay(30);
    assert.equal(getRequestWorkOutcome().dependencyInterrupted, true);
    assert.equal(scope.signal.aborted, false);
    await assert.rejects(
      loaders.options.contextLoaderFactory()(
        "https://www.w3.org/ns/activitystreams",
      ),
      /capacity/,
    );
    assert.equal(getRequestWorkOutcome().hardFailure?.kind, "overload");
    await assert.rejects(
      authenticated("https://remote.example/private"),
      /capacity/,
    );
    await assert.rejects(
      promise,
      (error: unknown) =>
        error instanceof FetchError &&
        error.cause instanceof DOMException &&
        error.cause.name === "TimeoutError",
    );
  }).then(() => {
    finished = true;
  });
  await started.promise;
  await delay(40);
  assert.equal(finished, false);
  assert.equal(loaders.stats().active, 1);
  pending.resolve({
    contextUrl: null,
    documentUrl: "https://remote.example/actor",
    document: {},
  });
  await work;
  assert.deepEqual(loaders.stats(), {
    active: 0,
    limit: 1,
    rejected: 2,
    timedOut: 1,
  });
});

test("an ignored raw HTTP cancellation retains work until actual settlement", async (t) => {
  const raw = deferred<Response>();
  const started = deferred<AbortSignal>();
  t.mock.method(
    globalThis,
    "fetch",
    (_request: unknown, options: RequestInit) => {
      assert(options.signal != null);
      started.resolve(options.signal);
      return raw.promise;
    },
  );
  const loaders = createProtocolLoaders({
    kv: new MemoryKvStore(),
    limit: 1,
    timeoutMs: 15,
  });
  let finished = false;
  const run = runWithRequestWork(new AbortController().signal, async () => {
    await assert.rejects(
      loaders.options.documentLoaderFactory({ allowPrivateAddress: true })(
        "https://remote.example/slow",
      ),
      /timed out/,
    );
  }).then(() => {
    finished = true;
  });
  const signal = await started.promise;
  await delay(30);
  assert.equal(signal.aborted, true);
  assert.equal(finished, false);
  assert.equal(loaders.stats().active, 1);
  raw.resolve(
    new Response("{}", {
      headers: { "content-type": "application/activity+json" },
    }),
  );
  await run;
  assert.equal(loaders.stats().active, 0);
});

test("caller abort marks its own request even when dispatched from another async context", async () => {
  const pending = deferred<unknown>();
  const started = deferred<void>();
  const kv = new MemoryKvStore();
  kv.get = async <T>() => {
    started.resolve();
    return (await pending.promise) as T;
  };
  const loaders = createProtocolLoaders({ kv, limit: 1, timeoutMs: 5000 });
  const caller = new AbortController();
  const parent = new AbortController();
  const work = runWithRequestWork(parent.signal, async () => {
    await assert.rejects(
      loaders.options.documentLoaderFactory()("https://remote.example/actor", {
        signal: caller.signal,
      }),
      /caller stopped/,
    );
    assert.equal(getRequestWorkOutcome().dependencyInterrupted, true);
    assert.equal(parent.signal.aborted, false);
  });
  await started.promise;
  await runWithRequestWork(new AbortController().signal, async () => {
    caller.abort(new Error("caller stopped"));
    assert.equal(getRequestWorkOutcome().dependencyInterrupted, false);
  });
  assert.equal(loaders.stats().active, 1);
  pending.resolve({ document: {} });
  await work;
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("aborted scope/caller cannot start a cache or preloaded lookup", async () => {
  const kv = new MemoryKvStore();
  let reads = 0;
  kv.get = async () => {
    reads++;
    return undefined;
  };
  const loaders = createProtocolLoaders({ kv, limit: 1, timeoutMs: 5000 });
  const caller = new AbortController();
  caller.abort(new Error("already stopped"));
  await runWithRequestWork(new AbortController().signal, async () => {
    await assert.rejects(
      loaders.options.contextLoaderFactory()(
        "https://www.w3.org/ns/activitystreams",
        { signal: caller.signal },
      ),
      /already stopped/,
    );
    assert.equal(getRequestWorkOutcome().dependencyInterrupted, true);
  });
  assert.equal(reads, 0);
  assert.equal(loaders.stats().active, 0);
  const scope = new AbortController();
  await runWithRequestWork(scope.signal, async () => {
    scope.abort(new Error("scope stopped"));
    await assert.rejects(
      loaders.options.documentLoaderFactory()("https://remote.example/actor"),
      /scope stopped/,
    );
  });
  assert.equal(reads, 0);
});

test("real stalled HTTP body cancellation completes socket cleanup", async () => {
  const started = deferred<void>();
  const disconnected = deferred<void>();
  const server = createServer((request, response) => {
    request.on("close", () => disconnected.resolve());
    response.writeHead(200, { "content-type": "application/activity+json" });
    response.write('{"unfinished":');
    started.resolve();
  });
  const origin = await listen(server);
  const loaders = createProtocolLoaders({
    kv: new MemoryKvStore(),
    limit: 1,
    timeoutMs: 50,
  });
  try {
    const work = runWithRequestWork(new AbortController().signal, async () => {
      await assert.rejects(
        loaders.options.documentLoaderFactory({ allowPrivateAddress: true })(
          `${origin}/slow`,
        ),
        /timed out/,
      );
      assert.equal(getRequestWorkOutcome().dependencyInterrupted, true);
    });
    await started.promise;
    await work;
    await disconnected.promise;
    assert.equal(loaders.stats().active, 0);
  } finally {
    await close(server);
  }
});

test("public-key guard skips all interrupted namespace writes and preserves other namespaces and requests", async () => {
  const underlying = new MemoryKvStore();
  const kv = createProtocolKvStore(underlying);
  const prefix: KvKey = ["_fedify", "publicKey", "https://remote.example/key"];
  await kv.set(prefix, null);
  assert.equal(await underlying.get(prefix), null);
  await kv.delete(prefix);
  for (const failure of ["soft", "hard", "abort"] as const) {
    const scope = new AbortController();
    await runWithRequestWork(scope.signal, async () => {
      if (failure === "soft")
        reportRequestDependencyInterruption(new Error("local"));
      else if (failure === "hard")
        reportRequestWorkFailure({
          kind: "overload",
          error: new Error("full"),
        });
      else scope.abort();
      await kv.set(prefix, null);
      await kv.set([...prefix, "__fetchError"], { message: "local" });
      await kv.set([...prefix, "positive"], { publicKey: "late" });
      await kv.set(["_fedify", "inbox", failure], true);
      await kv.set(["_fedify", "publicKeyExtra", failure], true);
      assert.equal(await underlying.get(prefix), undefined);
      assert.equal(
        await underlying.get([...prefix, "__fetchError"]),
        undefined,
      );
      assert.equal(await underlying.get([...prefix, "positive"]), undefined);
      assert.equal(await underlying.get(["_fedify", "inbox", failure]), true);
      assert.equal(
        await underlying.get(["_fedify", "publicKeyExtra", failure]),
        true,
      );
    });
  }
  await runWithRequestWork(new AbortController().signal, async () => {
    await kv.set(prefix, { healthy: true });
    assert.deepEqual(await underlying.get(prefix), { healthy: true });
  });
  assert.equal(await kv.cas?.(["ordinary"], undefined, "ok"), true);
  assert.equal(await kv.get(["ordinary"]), "ok");
  assert((await Array.fromAsync(kv.list(["_fedify", "inbox"]))).length === 3);
});

test("nested and concurrent key-cache scopes share only their own interruption", async () => {
  const underlying = new MemoryKvStore();
  const kv = createProtocolKvStore(underlying, ["custom", "keys"]);
  const interrupted = deferred<void>();
  const healthy = deferred<void>();
  await Promise.all([
    runWithRequestWork(new AbortController().signal, async () => {
      await runWithRequestWork(new AbortController().signal, async () => {
        reportRequestDependencyInterruption(
          new Error("optional lookup timeout"),
        );
      });
      interrupted.resolve();
      await healthy.promise;
      await kv.set(["custom", "keys", "interrupted"], "late");
      await kv.set(["_fedify", "publicKey", "different-prefix"], "normal");
    }),
    runWithRequestWork(new AbortController().signal, async () => {
      await interrupted.promise;
      await kv.set(["custom", "keys", "healthy"], "good");
      healthy.resolve();
    }),
  ]);
  assert.equal(
    await underlying.get(["custom", "keys", "interrupted"]),
    undefined,
  );
  assert.equal(await underlying.get(["custom", "keys", "healthy"]), "good");
  assert.equal(
    await underlying.get(["_fedify", "publicKey", "different-prefix"]),
    "normal",
  );
});
