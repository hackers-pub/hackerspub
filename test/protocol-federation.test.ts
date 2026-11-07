import {
  createFederationBuilder,
  type DocumentLoader,
  FetchError,
  generateCryptoKeyPair,
  getDocumentLoader,
  type KvStore,
  MemoryKvStore,
  type MessageQueue,
  type RequestContext,
  signRequest,
} from "@fedify/fedify";
import {
  CryptographicKey,
  Delete,
  Endpoints,
  Follow,
  Like,
  Note,
  Person,
} from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import {
  getRequestWorkOutcome,
  getRequestWorkSignal,
  reportRequestDependencyInterruption,
  reportRequestWorkFailure,
} from "@hackerspub/models/request-work";
import { loadProtocolHttpConfig } from "@hackerspub/runtime/config";
import assert from "node:assert/strict";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { onUnverifiedActivity } from "../federation/inbox/unverified.ts";
import {
  createProtocolKvStore,
  createProtocolLoaders,
} from "../runtime/protocol-loaders.ts";
import { ProtocolAdmission } from "../graphql/protocol-admission.ts";

// These fixtures use the real Fedify parser, signatures, authorization, inbox
// routing, and KV cache. Only remote documents and the durable queue are fakes;
// database-backed queue consumption is tested separately.
const localOrigin = "https://local.example";
const keyPair = generateCryptoKeyPair("RSASSA-PKCS1-v1_5");

interface Signer {
  readonly actorId: URL;
  readonly keyId: URL;
  readonly keys: CryptoKeyPair;
  readonly document: unknown;
}

async function signer(name = "sender"): Promise<Signer> {
  const keys = await keyPair;
  const actorId = new URL(`https://${name}.example/actor`);
  const keyId = new URL(`${actorId}#key`);
  const actor = new Person({
    id: actorId,
    preferredUsername: name,
    publicKey: new CryptographicKey({
      id: keyId,
      owner: actorId,
      publicKey: keys.publicKey,
    }),
  });
  return { actorId, keyId, keys, document: await actor.toJsonLd() };
}

interface FixtureOptions {
  deadlineMs?: number;
  limit?: number;
  queued?: boolean;
  guarded?: boolean;
  load?: DocumentLoader;
  loadFactory?: (kv: KvStore) => DocumentLoader;
  enqueue?: (message: unknown) => Promise<void>;
  optional?: (loader: DocumentLoader) => Promise<void>;
}

interface FederationFixture {
  readonly admission: ProtocolAdmission;
  readonly underlying: MemoryKvStore;
  readonly messages: unknown[];
  readonly calls: number;
  readonly handled: number;
  setLoad(next?: DocumentLoader): void;
  run(request: Request): Promise<Response>;
}

async function fixture(
  remote: Signer,
  options: FixtureOptions = {},
): Promise<FederationFixture> {
  const underlying = new MemoryKvStore();
  const kv =
    options.guarded === false ? underlying : createProtocolKvStore(underlying);
  let load = options.load;
  const generatedLoader = options.loadFactory?.(kv);
  let calls = 0;
  let handled = 0;
  const messages: unknown[] = [];
  const documentLoader: DocumentLoader = async (url, loaderOptions) => {
    calls++;
    if (load != null) return await load(url, loaderOptions);
    if (generatedLoader != null)
      return await generatedLoader(url, loaderOptions);
    assert(
      url.startsWith(remote.actorId.href),
      `unexpected remote lookup: ${url}`,
    );
    return {
      contextUrl: null,
      documentUrl: remote.actorId.href,
      document: remote.document,
    };
  };
  const builder = createFederationBuilder<void>();
  builder
    .setActorDispatcher(
      "/ap/actors/{identifier}",
      (ctx, identifier) =>
        new Person({
          id: ctx.getActorUri(identifier),
          preferredUsername: identifier,
          inbox: ctx.getInboxUri(identifier),
          endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
          publicKey: null,
          assertionMethod: null,
        }),
    )
    .setKeyPairsDispatcher(() => []);
  builder
    .setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
    .onUnverifiedActivity((ctx, activity, reason) =>
      // This production handler does not read ctx.data; the other callbacks
      // deliberately use no database-backed application context in this fixture.
      onUnverifiedActivity(
        ctx as unknown as RequestContext<ContextData>,
        activity,
        reason,
      ),
    )
    .setSharedKeyDispatcher(() => ({ identifier: "receiver" }))
    .on(Follow, async () => {
      handled++;
    });
  builder
    .setObjectDispatcher(Note, "/ap/notes/{id}", async (ctx, values) => {
      if (values.id === "public") await options.optional?.(ctx.documentLoader);
      return new Note({
        id: ctx.getObjectUri(Note, values),
        content: values.id,
      });
    })
    .authorize(async (ctx, values) => {
      if (values.id === "public") return true;
      const owner = await ctx.getSignedKeyOwner();
      return owner?.id?.href === remote.actorId.href;
    });
  const queue: MessageQueue = {
    async enqueue(message: unknown) {
      await options.enqueue?.(message);
      messages.push(message);
    },
    async listen() {
      throw new Error("HTTP must not start queue consumers");
    },
  };
  const federation = await builder.build({
    kv,
    queue: options.queued === false ? undefined : queue,
    manuallyStartQueue: true,
    documentLoaderFactory: () => documentLoader,
    contextLoaderFactory: () => getDocumentLoader({ timeout: null }),
  });
  const admission = new ProtocolAdmission({
    ...loadProtocolHttpConfig({}),
    deadlineMs: options.deadlineMs ?? 1000,
    limit: options.limit ?? 1,
  });
  return {
    admission,
    underlying,
    messages,
    get calls() {
      return calls;
    },
    get handled() {
      return handled;
    },
    setLoad(next?: DocumentLoader) {
      load = next;
    },
    run(request: Request) {
      return admission.run(request, (admitted) =>
        federation.fetch(admitted, { contextData: undefined }),
      );
    },
  };
}

async function signedFollow(
  remote: Signer,
  signal?: AbortSignal,
  id = crypto.randomUUID(),
) {
  const activity = new Follow({
    id: new URL(`/follows/${id}`, remote.actorId.origin),
    actor: remote.actorId,
    object: new URL(`${localOrigin}/ap/actors/receiver`),
  });
  return await signRequest(
    new Request(`${localOrigin}/ap/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify(await activity.toJsonLd()),
      signal,
    }),
    remote.keys.privateKey,
    remote.keyId,
    { spec: "draft-cavage-http-signatures-12" },
  );
}

async function signedGet(remote: Signer, path: string) {
  return await signRequest(
    new Request(`${localOrigin}${path}`, {
      headers: { accept: "application/activity+json" },
    }),
    remote.keys.privateKey,
    remote.keyId,
    { spec: "draft-cavage-http-signatures-12" },
  );
}

for (const mode of [
  "deadline",
  "overload",
  "local interruption",
  "disconnect",
] as const) {
  test(`real signed inbox ${mode} stays retryable without poisoning the next signer request`, async () => {
    const remote = await signer();
    const client = new AbortController();
    const entered = Promise.withResolvers<void>();
    const app = await fixture(remote, {
      deadlineMs: mode === "deadline" ? 150 : 1000,
      load: async () => {
        entered.resolve();
        if (mode === "local interruption") {
          const error = new Error("simulated local loader timer");
          reportRequestDependencyInterruption(error);
          throw error;
        }
        if (mode === "overload") {
          const error = new Error("simulated loader budget exhaustion");
          reportRequestWorkFailure({ kind: "overload", error });
          throw error;
        }
        const signal = getRequestWorkSignal();
        assert(signal != null);
        if (mode === "disconnect")
          client.abort(new Error("client disconnected"));
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        signal.throwIfAborted();
        throw new Error("expected cancellation");
      },
    });
    const request = await signedFollow(remote, client.signal);
    const first = app.run(request);
    await entered.promise;
    assert.equal(
      (await first).status,
      mode === "overload" ? 503 : mode === "disconnect" ? 499 : 504,
    );
    await app.admission.idle();
    assert.equal(app.messages.length, 0);
    assert.equal(
      (await Array.fromAsync(app.underlying.list(["_fedify", "publicKey"])))
        .length,
      0,
    );
    const failedCalls = app.calls;
    app.setLoad();
    assert.equal((await app.run(await signedFollow(remote))).status, 202);
    await app.admission.idle();
    assert(
      app.calls > failedCalls,
      "healthy HTTP retry must fetch the signer again",
    );
    assert.equal(app.messages.length, 1);
  });
}

test("unguarded Fedify negative cache reproduces a failed healthy retry", async () => {
  const remote = await signer();
  const app = await fixture(remote, {
    guarded: false,
    load: async () => {
      reportRequestDependencyInterruption(new Error("local interruption"));
      throw new Error("local interruption");
    },
  });
  assert.equal((await app.run(await signedFollow(remote))).status, 504);
  const calls = app.calls;
  app.setLoad();
  assert.equal((await app.run(await signedFollow(remote))).status, 401);
  assert.equal(app.calls, calls);
  assert.equal(app.messages.length, 0);
});

test("the real protocol loader timer owns ignored fetch cancellation and permits a healthy signed retry", async (t) => {
  const remote = await signer();
  const entered = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++fetches === 1) {
      entered.resolve();
      await cleaned.promise;
    }
    return new Response(JSON.stringify(remote.document), {
      headers: { "content-type": "application/activity+json" },
    });
  });
  let loaders!: ReturnType<typeof createProtocolLoaders>;
  const app = await fixture(remote, {
    loadFactory: (kv) => {
      loaders = createProtocolLoaders({ kv, limit: 8, timeoutMs: 100 });
      // Private addresses are enabled only for this injected-network test path.
      return loaders.options.documentLoaderFactory({
        allowPrivateAddress: true,
      });
    },
  });
  let replied = false;
  const first = app.run(await signedFollow(remote)).then((response) => {
    replied = true;
    return response;
  });
  await entered.promise;
  await delay(160);
  assert.equal(loaders.stats().timedOut, 1);
  assert.equal(loaders.stats().active, 1);
  assert.equal(app.admission.stats.active, 1);
  assert.equal(replied, false);
  cleaned.resolve();
  assert.equal((await first).status, 504);
  await app.admission.idle();
  assert.equal(loaders.stats().active, 0);
  assert.equal((await app.run(await signedFollow(remote))).status, 202);
  assert(fetches > 1);
  assert.equal(app.messages.length, 1);
});

test("genuine unavailable keys retain permanent rejection and ordinary negative caching", async () => {
  const remote = await signer();
  const app = await fixture(remote, {
    load: async (url) => {
      throw new FetchError(
        url,
        "Key not found",
        new Response(null, { status: 404 }),
      );
    },
  });
  assert.equal((await app.run(await signedFollow(remote))).status, 401);
  const calls = app.calls;
  app.setLoad();
  assert.equal((await app.run(await signedFollow(remote))).status, 401);
  assert.equal(app.calls, calls);
  assert.equal(app.messages.length, 0);
});

test("an ordinary invalid signature remains unauthorized without a retryable marker", async () => {
  const remote = await signer();
  const app = await fixture(remote);
  const request = await signedFollow(remote);
  const headers = new Headers(request.headers);
  const signature = headers.get("signature");
  assert(signature != null);
  headers.set(
    "signature",
    signature.replace(/signature="[^"]*"/, 'signature="AA=="'),
  );
  assert.equal((await app.run(new Request(request, { headers }))).status, 401);
  await app.admission.idle();
  assert.equal(app.messages.length, 0);
});

test("a concurrent interrupted signer cannot suppress another request's key cache", async () => {
  const remote = await signer();
  const healthy = await signer("healthy");
  const interrupted = Promise.withResolvers<void>();
  const healthyCached = Promise.withResolvers<void>();
  const app = await fixture(remote, {
    limit: 2,
    load: async (url) => {
      if (url.startsWith(remote.actorId.href)) {
        reportRequestDependencyInterruption(new Error("local interruption"));
        interrupted.resolve();
        await healthyCached.promise;
        throw new Error("local interruption");
      }
      assert(url.startsWith(healthy.actorId.href));
      await interrupted.promise;
      return {
        contextUrl: null,
        documentUrl: healthy.actorId.href,
        document: healthy.document,
      };
    },
  });
  const first = app.run(await signedFollow(remote));
  await interrupted.promise;
  assert.equal((await app.run(await signedFollow(healthy))).status, 202);
  healthyCached.resolve();
  assert.equal((await first).status, 504);
  await app.admission.idle();
  const entries = await Array.fromAsync(
    app.underlying.list(["_fedify", "publicKey"]),
  );
  assert(entries.some((entry) => entry.key.includes(healthy.keyId.href)));
  assert(!entries.some((entry) => entry.key.includes(remote.keyId.href)));
  assert.equal(app.messages.length, 1);
});

test("public Note optional mention fallback waits for cleanup and keeps a successful response", async () => {
  const remote = await signer();
  const entered = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const app = await fixture(remote, {
    load: async () => {
      reportRequestDependencyInterruption(
        new Error("optional mention timeout"),
      );
      entered.resolve();
      await cleanup.promise;
      throw new Error("optional mention timeout");
    },
    optional: async (loader) => {
      try {
        await loader("https://mention.example/actor", { suppressError: true });
      } catch {
        // The public-object callback can fall back after an optional mention.
      }
    },
  });
  let returned = false;
  const work = app
    .run(
      new Request(`${localOrigin}/ap/notes/public`, {
        headers: { accept: "application/activity+json" },
      }),
    )
    .then((response) => {
      returned = true;
      return response;
    });
  await entered.promise;
  await setImmediate();
  assert.equal(returned, false);
  assert.equal(app.admission.stats.active, 1);
  cleanup.resolve();
  const response = await work;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, "public");
});

test("a public object callback that swallows hard overload cannot acknowledge success", async () => {
  const remote = await signer();
  const app = await fixture(remote, {
    optional: async () => {
      reportRequestWorkFailure({
        kind: "overload",
        error: new Error("SQL/loader capacity exhausted"),
      });
    },
  });
  assert.equal(
    (
      await app.run(
        new Request(`${localOrigin}/ap/notes/public`, {
          headers: { accept: "application/activity+json" },
        }),
      )
    ).status,
    503,
  );
  await app.admission.idle();
});

test("private Note authorization preserves signed/unsigned and public visibility", async () => {
  const remote = await signer();
  const app = await fixture(remote);
  const headers = { accept: "application/activity+json" };
  assert.equal(
    (await app.run(new Request(`${localOrigin}/ap/notes/private`, { headers })))
      .status,
    401,
  );
  assert.equal(
    (await app.run(await signedGet(remote, "/ap/notes/private"))).status,
    200,
  );
  assert.equal(
    (await app.run(new Request(`${localOrigin}/ap/notes/public`, { headers })))
      .status,
    200,
  );
  const outsider = await signer("outsider");
  app.setLoad(async () => ({
    contextUrl: null,
    documentUrl: outsider.actorId.href,
    document: outsider.document,
  }));
  assert.equal(
    (await app.run(await signedGet(outsider, "/ap/notes/private"))).status,
    401,
  );
});

test("private Note local key interruption is retryable and does not poison signed access", async () => {
  const remote = await signer();
  const app = await fixture(remote, {
    load: async () => {
      reportRequestDependencyInterruption(new Error("local key timeout"));
      throw new Error("local key timeout");
    },
  });
  assert.equal(
    (await app.run(await signedGet(remote, "/ap/notes/private"))).status,
    504,
  );
  app.setLoad();
  assert.equal(
    (await app.run(await signedGet(remote, "/ap/notes/private"))).status,
    200,
  );
});

test("a timed-out uncooperative inbox enqueue keeps its permit through actual persistence", async () => {
  const remote = await signer();
  const entered = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const app = await fixture(remote, {
    deadlineMs: 120,
    enqueue: async () => {
      entered.resolve();
      await committed.promise;
    },
  });
  const run = app.run(await signedFollow(remote));
  await entered.promise;
  assert.equal((await run).status, 504);
  assert.equal(app.messages.length, 0);
  assert.equal(app.admission.stats.active, 1);
  assert.equal((await app.run(await signedFollow(remote))).status, 503);
  committed.resolve();
  await app.admission.idle();
  assert.equal(
    app.messages.length,
    1,
    "timeout does not establish enqueue rollback",
  );
  assert.equal(app.admission.stats.active, 0);
});

test("normal queued inbox success is acknowledged only after enqueue settles", async () => {
  const remote = await signer();
  const entered = Promise.withResolvers<void>();
  const persisted = Promise.withResolvers<void>();
  const app = await fixture(remote, {
    enqueue: async () => {
      entered.resolve();
      await persisted.promise;
    },
  });
  let replied = false;
  const run = app.run(await signedFollow(remote)).then((response) => {
    replied = true;
    return response;
  });
  await entered.promise;
  await delay(10);
  assert.equal(replied, false);
  assert.equal(app.messages.length, 0);
  persisted.resolve();
  assert.equal((await run).status, 202);
  assert.equal(app.messages.length, 1);
});

test("inbox enqueue failure never becomes an accepted response", async () => {
  const remote = await signer();
  const id = crypto.randomUUID();
  let attempts = 0;
  const app = await fixture(remote, {
    enqueue: async () => {
      if (++attempts === 1) throw new Error("durable queue unavailable");
    },
  });
  try {
    const response = await app.run(await signedFollow(remote, undefined, id));
    assert(response.status >= 500);
  } catch (error) {
    assert.match(String(error), /durable queue unavailable/);
  }
  await app.admission.idle();
  assert.equal(app.messages.length, 0);
  assert.equal(
    (await app.run(await signedFollow(remote, undefined, id))).status,
    202,
  );
  await app.admission.idle();
  assert.equal(attempts, 2);
  assert.equal(app.messages.length, 1);
});

test("an interrupted RFC 9421 key followed by a gone key cannot acknowledge a Delete", async () => {
  const remote = await signer();
  const goneKey = new URL("https://gone.example/actor#key");
  const lookups: string[] = [];
  const app = await fixture(remote, {
    load: async (url) => {
      lookups.push(url);
      if (url.startsWith(remote.actorId.href)) {
        const error = new Error("local key lookup timeout");
        reportRequestDependencyInterruption(error);
        throw error;
      }
      assert(url.startsWith("https://gone.example/actor"));
      throw new FetchError(
        url,
        "Actor gone",
        new Response(null, { status: 410 }),
      );
    },
  });
  const activity = new Delete({
    id: new URL("/deletes/multiple-keys", remote.actorId.origin),
    actor: remote.actorId,
    object: remote.actorId,
  });
  const first = await signRequest(
    new Request(`${localOrigin}/ap/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify(await activity.toJsonLd()),
    }),
    remote.keys.privateKey,
    remote.keyId,
    { spec: "rfc9421", rfc9421: { label: "interrupted" } },
  );
  const request = await signRequest(first, remote.keys.privateKey, goneKey, {
    spec: "rfc9421",
    rfc9421: { label: "gone" },
  });
  assert.equal((await app.run(request)).status, 504);
  await app.admission.idle();
  assert(lookups.some((url) => url.startsWith(remote.actorId.href)));
  assert(lookups.some((url) => url.startsWith("https://gone.example/actor")));
  assert.equal(app.messages.length, 0);
});

test("inline inbox duplicate and unsupported activity acknowledgements remain accepted", async () => {
  const remote = await signer();
  const app = await fixture(remote, { queued: false });
  const id = crypto.randomUUID();
  assert.equal(
    (await app.run(await signedFollow(remote, undefined, id))).status,
    202,
  );
  assert.equal(
    (await app.run(await signedFollow(remote, undefined, id))).status,
    202,
  );
  assert.equal(app.handled, 1);
  const activity = new Like({
    id: new URL("https://sender.example/likes/1"),
    actor: remote.actorId,
    object: new URL(`${localOrigin}/ap/notes/public`),
  });
  const request = await signRequest(
    new Request(`${localOrigin}/ap/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify(await activity.toJsonLd()),
    }),
    remote.keys.privateKey,
    remote.keyId,
    { spec: "draft-cavage-http-signatures-12" },
  );
  assert.equal((await app.run(request)).status, 202);
  assert.equal(app.handled, 1);
  assert.equal(getRequestWorkOutcome().dependencyInterrupted, false);
});

test("the production gone-actor Delete acknowledgement survives protocol admission", async () => {
  const remote = await signer();
  for (const status of [410, 404]) {
    const app = await fixture(remote, {
      load: async (url) => {
        throw new FetchError(
          url,
          "Actor unavailable",
          new Response(null, { status }),
        );
      },
    });
    const activity = new Delete({
      id: new URL(`/deletes/${status}`, remote.actorId.origin),
      actor: remote.actorId,
      object: remote.actorId,
    });
    const request = await signRequest(
      new Request(`${localOrigin}/ap/inbox`, {
        method: "POST",
        headers: { "content-type": "application/activity+json" },
        body: JSON.stringify(await activity.toJsonLd()),
      }),
      remote.keys.privateKey,
      remote.keyId,
      { spec: "draft-cavage-http-signatures-12" },
    );
    assert.equal((await app.run(request)).status, status === 410 ? 202 : 401);
    assert.equal(app.messages.length, 0);
  }
});
