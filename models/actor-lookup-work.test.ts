import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { persistActorsByHandles } from "./actor.ts";
import type { ApplicationContext } from "./context.ts";
import { extractMentionsFromHtml, renderMarkup } from "./markup.ts";
import { runWithRequestWork } from "./request-work.ts";

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
