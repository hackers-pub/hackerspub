import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { DocumentLoader } from "@fedify/fedify";
import { lookupObject, Person } from "@fedify/vocab";
import { persistActor, persistActorsByHandles } from "./actor.ts";
import type { ApplicationContext } from "./context.ts";
import { extractMentionsFromHtml, renderMarkup } from "./markup.ts";
import { runWithRequestWork } from "./request-work.ts";
import { instanceTable } from "./schema.ts";

function makeContext(lookup: ApplicationContext["lookupObject"]) {
  const writes: string[] = [];
  const queries: unknown[] = [];
  const ctx = {
    canonicalOrigin: "https://example.test",
    db: {
      query: {
        actorTable: {
          async findMany(args: unknown) {
            queries.push(args);
            return [];
          },
        },
      },
    },
    kv: {
      async getMany(keys: string[]) {
        return keys.map(() => undefined);
      },
      async set(key: string) {
        writes.push(key);
        return true;
      },
    },
    getDocumentLoader() {
      return Promise.resolve(async () => {
        throw new Error("unused loader");
      });
    },
    lookupObject: lookup,
    withDatabase(db: unknown) {
      return { ...ctx, db };
    },
  } as unknown as ApplicationContext;
  return { ctx, writes, queries };
}

test(
  "real markup mention timeout retains the raw lookup until completion",
  { timeout: 5_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const lookup = Promise.withResolvers<null>();
    const started = Promise.withResolvers<void>();
    const rendered = Promise.withResolvers<void>();
    const { ctx, writes } = makeContext(async () => {
      started.resolve();
      return lookup.promise;
    });
    let complete = false;
    const request = runWithRequestWork(
      new AbortController().signal,
      async () => {
        const result = await renderMarkup(ctx, "Hello @alice@remote.test");
        assert.match(result.html, /alice/);
        rendered.resolve();
        return result;
      },
    ).then(() => {
      complete = true;
    });
    await started.promise;
    t.mock.timers.tick(5_000);
    await rendered.promise;
    await setImmediate();
    assert.equal(complete, false);
    assert.deepEqual(writes, ["unreachable-handles/@alice@remote.test"]);
    lookup.resolve(null);
    await request;
  },
);

test("successful actor lookup clears its losing timeout without a late KV write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, writes } = makeContext(async () => null);
  assert.deepEqual(
    await persistActorsByHandles(ctx, ["@alice@remote.test"]),
    {},
  );
  t.mock.timers.tick(10_000);
  await setImmediate();
  assert.deepEqual(writes, []);
});

test("actor lookup cancellation survives database rebinding and starts no later handles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cancelled = new AbortController();
  const lookup = Promise.withResolvers<null>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const { ctx, writes } = makeContext(async () => {
    calls++;
    if (calls === 5) started.resolve();
    return lookup.promise;
  });
  const rebound = ctx.withDatabase(ctx.db);
  let complete = false;
  const request = runWithRequestWork(cancelled.signal, async () =>
    persistActorsByHandles(
      rebound,
      Array.from({ length: 8 }, (_, index) => `@user${index}@remote.test`),
    ),
  );
  void request.then(
    () => {
      complete = true;
    },
    () => {
      complete = true;
    },
  );
  await started.promise;
  cancelled.abort();
  t.mock.timers.tick(5_000);
  await setImmediate();
  assert.equal(complete, false);
  assert.equal(calls, 5);
  assert.deepEqual(writes, []);
  lookup.resolve(null);
  await assert.rejects(request, { name: "AbortError" });
  assert.equal(calls, 5);
});

test("HTML mention extraction timeout also retains its raw lookup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lookup = Promise.withResolvers<null>();
  const started = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  const { ctx } = makeContext(async () => {
    started.resolve();
    return lookup.promise;
  });
  let complete = false;
  const request = runWithRequestWork(new AbortController().signal, async () => {
    assert.deepEqual(
      await extractMentionsFromHtml(
        ctx,
        '<a class="mention" href="https://remote.test/alice">Alice</a>',
      ),
      [],
    );
    returned.resolve();
  }).then(() => {
    complete = true;
  });
  await started.promise;
  t.mock.timers.tick(3_000);
  await returned.promise;
  await setImmediate();
  assert.equal(complete, false);
  lookup.resolve(null);
  await request;
});

test("request cancellation reaches the real actor lookup signal", async () => {
  const cancel = new AbortController();
  const started = Promise.withResolvers<void>();
  let observed: AbortSignal | undefined;
  const { ctx, writes } = makeContext(async (_handle, options) => {
    observed = (options as { signal?: AbortSignal }).signal;
    started.resolve();
    return await new Promise<null>((_resolve, reject) =>
      observed?.addEventListener("abort", () => reject(observed?.reason), {
        once: true,
      }),
    );
  });
  const running = runWithRequestWork(cancel.signal, () =>
    persistActorsByHandles(ctx, ["@signal@remote.test"]),
  );
  await started.promise;
  assert.equal(observed, cancel.signal);
  cancel.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.deepEqual(writes, []);
});

for (const target of ["document", "context"]) {
  test(`actor property ${target} loader observes cancellation even when the getter suppresses it`, async (t) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 404 }),
    );
    const cancel = new AbortController();
    const started = Promise.withResolvers<void>();
    let observed: AbortSignal | undefined;
    const loader: DocumentLoader = async (_url, options) => {
      observed = options?.signal;
      started.resolve();
      return await new Promise((_resolve, reject) => {
        observed?.addEventListener("abort", () => reject(observed?.reason), {
          once: true,
        });
      });
    };
    const actor = new Person({
      id: new URL("https://remote.test/alice"),
      preferredUsername: "alice",
      inbox: new URL("https://remote.test/alice/inbox"),
      icon: new URL("https://remote.test/alice/icon"),
    });
    let tagsStarted = false;
    t.mock.method(actor, "getTags", () => {
      tagsStarted = true;
      throw new Error("cancelled actor must not load tags");
    });
    const { ctx } = makeContext(async () => null);
    const documentLoader: DocumentLoader =
      target === "document"
        ? loader
        : async () => ({
            contextUrl: null,
            documentUrl: "https://remote.test/alice/icon",
            document: {
              "@context": "https://remote.test/icon-context",
              id: "https://remote.test/alice/icon",
              type: "Image",
            },
          });
    let authenticatedLoaderRequested = false;
    const context = {
      ...ctx,
      documentLoader: async () => {
        throw new Error("must use an authenticated document loader");
      },
      getDocumentLoader(options: unknown) {
        assert.deepEqual(options, { identifier: "example.test" });
        authenticatedLoaderRequested = true;
        return documentLoader;
      },
      contextLoader: loader,
      db: {
        query: {
          actorTable: {
            async findFirst() {
              return undefined;
            },
          },
        },
        insert(table: unknown) {
          assert.equal(
            table,
            instanceTable,
            "cancelled actor must not be inserted",
          );
          return {
            values() {
              return {
                onConflictDoUpdate() {
                  return {
                    async returning() {
                      return [{ host: "remote.test" }];
                    },
                  };
                },
              };
            },
          };
        },
      },
    } as unknown as ApplicationContext;
    const running = runWithRequestWork(cancel.signal, () =>
      persistActor(context, actor),
    );
    await started.promise;
    assert.ok(observed instanceof AbortSignal);
    assert.equal(observed.aborted, false);
    cancel.abort();
    assert.equal(observed.aborted, true);
    await assert.rejects(running, { name: "AbortError" });
    assert.equal(observed.aborted, true);
    assert.equal(authenticatedLoaderRequested, true);
    assert.equal(tagsStarted, false);
  });
}

test("real actor lookup cancels an uncached JSON-LD context load", async () => {
  const cancel = new AbortController();
  const started = Promise.withResolvers<void>();
  let observed: AbortSignal | undefined;
  const contextLoader: DocumentLoader = async (_url, options) => {
    observed = options?.signal;
    started.resolve();
    return await new Promise((_resolve, reject) => {
      observed?.addEventListener("abort", () => reject(observed?.reason), {
        once: true,
      });
    });
  };
  const documentLoader: DocumentLoader = async () => ({
    contextUrl: null,
    documentUrl: "https://remote.test/alice",
    document: {
      "@context": "https://remote.test/uncached-context",
      id: "https://remote.test/alice",
      type: "Person",
    },
  });
  const { ctx, writes } = makeContext((_handle, options) =>
    lookupObject(new URL("https://remote.test/alice"), options),
  );
  const context = {
    ...ctx,
    contextLoader,
    getDocumentLoader() {
      return documentLoader;
    },
  } as ApplicationContext;
  const running = runWithRequestWork(cancel.signal, () =>
    persistActorsByHandles(context, ["@alice@remote.test"]),
  );
  await started.promise;
  assert.ok(observed instanceof AbortSignal);
  cancel.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(observed.aborted, true);
  assert.deepEqual(writes, []);
});
