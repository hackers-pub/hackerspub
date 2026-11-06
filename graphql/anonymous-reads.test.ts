import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  createMemoryAnonymousReadStore,
  type AnonymousReadStore,
} from "@hackerspub/runtime/anonymous-read-admission";
import { loadAnonymousReadConfig } from "@hackerspub/runtime/config";
import { createSchema, createYoga } from "graphql-yoga";
import { GraphQLError } from "graphql";
import {
  AnonymousReadController,
  useAnonymousReadAdmission,
} from "./anonymous-reads.ts";
import { useQuerySnapshotTransaction } from "./query-tx-plugin.ts";
import { isCheapGuestQuery } from "./anonymous-read-policy.ts";
import type { UserContext } from "./builder.ts";

function deferred<T = void>() {
  return Promise.withResolvers<T>();
}
function makeController(options = {}) {
  const config = {
    ...loadAnonymousReadConfig({}),
    localLimit: 1,
    globalLimit: 1,
    joinWindowMs: 1000,
    ...options,
  };
  return new AnonymousReadController(
    createMemoryAnonymousReadStore(config.globalLimit),
    config,
  );
}
function request(controller?: AbortController) {
  return new Request("https://example.com/graphql", {
    signal: controller?.signal,
  });
}

test("identical reads share before admission; distinct work and followers stay bounded", async () => {
  const controller = makeController({ followerLimit: 1 });
  const done = deferred<number>();
  let calls = 0;
  const execute = async () => {
    calls++;
    return await done.promise;
  };
  const leader = controller.run(request(), "same", execute);
  const follower = controller.run(request(), "same", execute);
  await assert.rejects(
    async () => controller.run(request(), "same", execute),
    (error: GraphQLError) => error.extensions.reason === "followers",
  );
  await assert.rejects(
    async () => controller.run(request(), "distinct", execute),
    (error: GraphQLError) => error.extensions.reason === "local",
  );
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(controller.stats.active, 1);
  assert.equal(controller.stats.followers, 1);
  done.resolve(7);
  assert.deepEqual(await Promise.all([leader, follower]), [7, 7]);
  assert.equal(controller.stats.active, 0);
  assert.equal(controller.stats.followers, 0);
  assert.equal(await controller.run(request(), "same", async () => 8), 8);
});

test("leader disconnect cannot cancel surviving follower; last abort retains real capacity", async () => {
  const controller = makeController();
  const first = new AbortController();
  const second = new AbortController();
  const started = deferred();
  const finished = deferred<number>();
  let sharedSignal: AbortSignal | undefined;
  const leader = controller.run(request(first), "same", async (req) => {
    sharedSignal = req.signal;
    started.resolve();
    return await finished.promise;
  });
  const follower = controller.run(request(second), "same", async () => 99);
  await started.promise;
  first.abort();
  await assert.rejects(leader, { name: "AbortError" });
  assert.equal(sharedSignal?.aborted, false);
  second.abort();
  await assert.rejects(follower, { name: "AbortError" });
  assert.equal(sharedSignal?.aborted, true);
  assert.equal(controller.stats.active, 1);
  await assert.rejects(async () =>
    controller.run(request(), "same", async () => 99),
  );
  finished.resolve(3);
  await setImmediate();
  assert.equal(controller.stats.active, 0);
  assert.equal(await controller.run(request(), "same", async () => 4), 4);
});

test("cancelled follower subscriptions are removed and do not accumulate reactions", async () => {
  const controller = makeController({ followerLimit: 1 });
  const finished = deferred();
  const leader = controller.run(request(), "same", () => finished.promise);
  for (let i = 0; i < 100; i++) {
    const cancellation = new AbortController();
    const follower = controller.run(
      request(cancellation),
      "same",
      async () => {},
    );
    cancellation.abort();
    await assert.rejects(follower);
    assert.equal(controller.stats.followers, 0);
  }
  finished.resolve();
  await leader;
});

test("cancellation during acquire skips SQL and releases a confirmed owner", async () => {
  const acquiring = deferred<boolean>();
  let released = 0;
  const store: AnonymousReadStore = {
    acquire: () => acquiring.promise,
    release: async () => {
      released++;
    },
    close: async () => {},
  };
  const controller = new AnonymousReadController(
    store,
    loadAnonymousReadConfig({}),
  );
  const cancel = new AbortController();
  let calls = 0;
  const result = controller.run(request(cancel), undefined, async () => {
    calls++;
  });
  await setImmediate();
  cancel.abort();
  await assert.rejects(result);
  assert.equal(controller.stats.active, 1);
  acquiring.resolve(true);
  await setImmediate();
  assert.equal(calls, 0);
  assert.equal(released, 1);
  assert.equal(controller.stats.active, 0);
});

test("aborted-before-admission does no work; independent authentication and cheap lanes remain bounded", async () => {
  const controller = makeController({ authLimit: 1, cheapLimit: 1 });
  const cancel = new AbortController();
  cancel.abort();
  assert.throws(
    () => controller.run(request(cancel), undefined, async () => 1),
    { name: "AbortError" },
  );
  const held = deferred();
  const expensive = controller.run(request(), undefined, () => held.promise);
  const auth = controller.authenticate(() => held.promise);
  await assert.rejects(controller.authenticate(async () => 1));
  assert.equal(await controller.cheap(request(), async () => 2), 2);
  const cheap = controller.cheap(request(), () => held.promise);
  await assert.rejects(controller.cheap(request(), async () => 2));
  held.resolve();
  await Promise.all([expensive, auth, cheap]);
});

test("two API controllers share one deployment limit", async () => {
  const store = createMemoryAnonymousReadStore(1);
  const config = loadAnonymousReadConfig({});
  const a = new AnonymousReadController(store, config),
    b = new AnonymousReadController(store, config);
  const held = deferred();
  const running = a.run(request(), undefined, () => held.promise);
  await setImmediate();
  await assert.rejects(
    b.run(request(), undefined, async () => 1),
    (error: GraphQLError) => error.extensions.reason === "global",
  );
  held.resolve();
  await running;
  assert.equal(await b.run(request(), undefined, async () => 2), 2);
});

function yogaFixture(
  controller: AnonymousReadController,
  resolve: () => Promise<string>,
) {
  let transactions = 0;
  const db = {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      return await run(db);
    },
  };
  const fedCtx = { db, withDatabase: () => fedCtx };
  const yoga = createYoga<{}, UserContext>({
    schema: createSchema({
      typeDefs: `type Query { expensive: String, viewer: String, webPushVapidPublicKey: String } type Mutation { change: String }`,
      resolvers: {
        Query: {
          expensive: resolve,
          viewer: () => null,
          webPushVapidPublicKey: () => "public",
        },
        Mutation: { change: () => "changed" },
      },
    }),
    context: ({ request: req }) =>
      ({
        request: req,
        db,
        fedCtx,
        session: undefined,
        account: undefined,
      }) as unknown as UserContext,
    plugins: [
      useQuerySnapshotTransaction({
        shouldSkip: (args, context) =>
          isCheapGuestQuery(args.document, args.operationName, context),
      }),
      useAnonymousReadAdmission(controller),
    ],
  });
  const fetch = (query: string) =>
    yoga.fetch(
      new Request("http://example.com/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      }),
    );
  return {
    yoga,
    fetch,
    get transactions() {
      return transactions;
    },
  };
}

test("real Yoga overload is retryable HTTP503 before transaction; cheap layout and mutations succeed", async () => {
  const controller = makeController();
  const held = deferred<string>();
  const started = deferred();
  const fixture = yogaFixture(controller, async () => {
    started.resolve();
    return await held.promise;
  });
  const first = fixture.fetch("{ expensive }");
  await started.promise;
  const overloaded = await fixture.fetch("{ expensive }");
  assert.equal(overloaded.status, 503);
  assert.equal(overloaded.headers.get("retry-after"), "1");
  assert.equal(overloaded.headers.get("cache-control"), "no-store");
  assert.equal(fixture.transactions, 1);
  assert.equal(
    (await (await fixture.fetch("{ viewer webPushVapidPublicKey }")).json())
      .data.webPushVapidPublicKey,
    "public",
  );
  assert.equal(fixture.transactions, 1);
  assert.equal(
    (await (await fixture.fetch("mutation { change }")).json()).data.change,
    "changed",
  );
  assert.equal(fixture.transactions, 1);
  held.resolve("ok");
  assert.equal((await (await first).json()).data.expensive, "ok");
  await fixture.yoga.dispose();
});

test("shutdown waits for actual ownership release before closing the store", async () => {
  const memory = createMemoryAnonymousReadStore(1);
  const events: string[] = [];
  const store: AnonymousReadStore = {
    acquire: memory.acquire,
    async release(owner) {
      await memory.release(owner);
      events.push("released");
    },
    async close() {
      events.push("closed");
      await memory.close();
    },
  };
  const admission = new AnonymousReadController(store, {
    ...loadAnonymousReadConfig({}),
    localLimit: 1,
  });
  const finish = deferred();
  const entered = deferred();
  const cancellation = new AbortController();
  const running = admission.run(request(cancellation), undefined, async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  cancellation.abort();
  await assert.rejects(running);
  const idle = admission.idle();
  assert.equal(admission.idle(), idle);
  const shutdown = idle.then(() => store.close());
  await setImmediate();
  assert.deepEqual(events, []);
  assert.equal(admission.stats.active, 1);
  finish.resolve();
  await shutdown;
  assert.deepEqual(events, ["released", "closed"]);
  assert.equal(admission.stats.active, 0);
});
