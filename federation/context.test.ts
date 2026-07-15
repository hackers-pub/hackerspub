import { assertStrictEquals } from "@std/assert";
import type { Context, InboxContext } from "@fedify/fedify";
import type {
  AfterCommitTask,
  ApplicationContext,
  ContextData,
} from "@hackerspub/models/context";
import {
  getFedifyContext,
  toApplicationContext,
  withInboxTransaction,
} from "./context.ts";
import { getCurrentOutboxDatabase } from "./outbox-queue.ts";

function createFedifyContext(data: ContextData): Context<ContextData> {
  const documentLoader = () => Promise.reject(new Error("Not implemented"));
  return {
    data,
    clone: createFedifyContext,
    origin: "https://example.com",
    canonicalOrigin: "https://example.com",
    host: "example.com",
    documentLoader,
    contextLoader: documentLoader,
    getActorUri: () => new URL("https://example.com/actor"),
    getInboxUri: () => new URL("https://example.com/inbox"),
    getOutboxUri: () => new URL("https://example.com/outbox"),
    getFollowersUri: () => new URL("https://example.com/followers"),
    getFollowingUri: () => new URL("https://example.com/following"),
    getFeaturedUri: () => new URL("https://example.com/featured"),
    getObjectUri: () => new URL("https://example.com/object"),
    getDocumentLoader: () => documentLoader,
    lookupObject: () => Promise.resolve(null),
    lookupWebFinger: () => Promise.resolve(null),
    sendActivity: () => Promise.resolve(),
  } as unknown as Context<ContextData>;
}

Deno.test("Fedify adapter state survives application context cloning", () => {
  const rootDb = {} as ContextData["db"];
  const transactionDb = {} as ContextData["db"];
  const data = { db: rootDb } as ContextData;
  const fedifyContext = {
    data,
    clone(nextData: ContextData) {
      return { ...this, data: nextData };
    },
  } as Context<ContextData>;
  const context = {
    db: transactionDb,
    federation: fedifyContext,
  } as ApplicationContext;

  const adapted = getFedifyContext({ ...context });
  assertStrictEquals(adapted.data.db, transactionDb);
  assertStrictEquals(fedifyContext.data.db, rootDb);
});

Deno.test("database rebinding preserves transaction adapter state", () => {
  const rootDb = {} as ContextData["db"];
  const transactionDb = {} as ContextData["db"];
  const reboundDb = {} as ContextData["db"];
  const afterCommit: AfterCommitTask[] = [];
  const applicationContext = toApplicationContext(
    createFedifyContext({ db: rootDb } as ContextData),
  );
  const transactionContext = {
    ...applicationContext,
    db: transactionDb,
    rootDb,
    afterCommit,
  };

  const rebound = transactionContext.withDatabase(reboundDb);

  assertStrictEquals(rebound.db, reboundDb);
  assertStrictEquals(rebound.rootDb, rootDb);
  assertStrictEquals(rebound.afterCommit, afterCommit);
});

Deno.test("sendActivity binds the rebound transaction to the outbox", async () => {
  const rootDb = {} as ContextData["db"];
  const transactionDb = {} as ContextData["db"];
  let observedDb: ContextData["db"] | undefined;
  const context = toApplicationContext(
    createFedifyContext({ db: rootDb } as ContextData),
  ).withDatabase(transactionDb);
  const reboundFedifyContext = context.federation as Context<ContextData>;
  reboundFedifyContext.sendActivity = () => {
    observedDb = getCurrentOutboxDatabase() as ContextData["db"] | undefined;
    return Promise.resolve();
  };

  await context.sendActivity({}, {}, {} as never);

  assertStrictEquals(observedDb, transactionDb);
});

Deno.test("inbox transactions rebind the Fedify context database", async () => {
  const transactionDb = {} as ContextData["db"];
  let committed = false;
  const rootDb = {
    async transaction(callback: (db: ContextData["db"]) => Promise<void>) {
      await callback(transactionDb);
      committed = true;
    },
  } as unknown as ContextData["db"];
  const context = createFedifyContext({ db: rootDb } as ContextData);

  await withInboxTransaction(
    context as InboxContext<ContextData>,
    async (txContext) => {
      assertStrictEquals(txContext.data.db, transactionDb);
      assertStrictEquals(committed, false);
    },
  );

  assertStrictEquals(committed, true);
});
