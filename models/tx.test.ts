import assert from "node:assert";
import test from "node:test";
import type { ApplicationContext } from "./context.ts";
import type { Database } from "./db.ts";
import { queueAfterCommit, withTransaction } from "./tx.ts";

function createFakeDb(): Database {
  const db = {
    transaction: async <T>(callback: (tx: Database) => Promise<T>) =>
      await callback(createFakeDb()),
  } as Database;
  return db;
}

function createContext(
  db: Database,
  capabilityDbs: Database[] = [],
  services: ApplicationContext["services"] = {} as never,
): ApplicationContext {
  const never = () => {
    throw new Error("Unexpected federation capability call.");
  };
  return {
    db,
    withDatabase: (nextDb) => createContext(nextDb, capabilityDbs, services),
    storage: {} as never,
    kv: {} as never,
    models: {} as never,
    services,
    federation: {},
    origin: "http://localhost/",
    canonicalOrigin: "http://localhost/",
    host: "localhost",
    documentLoader: never,
    contextLoader: never,
    getActorUri: never,
    getInboxUri: never,
    getOutboxUri: never,
    getFollowersUri: never,
    getFollowingUri: never,
    getFeaturedUri: never,
    getObjectUri: never,
    getDocumentLoader: never,
    lookupObject: async () => {
      capabilityDbs.push(db);
      return null;
    },
    lookupWebFinger: never,
    getActor: never,
    sendActivity: never,
  };
}

test("withTransaction() discards after-commit tasks from rolled back nested transactions", async () => {
  const completedTasks: string[] = [];
  const context = createContext(createFakeDb());

  await withTransaction(context, async (outerContext) => {
    await assert.rejects(
      async () =>
        await withTransaction(outerContext, async (innerContext) => {
          await queueAfterCommit(
            innerContext,
            () => {
              completedTasks.push("inner");
            },
          );
          throw new Error("roll back nested transaction");
        }),
      /roll back nested transaction/,
    );

    await queueAfterCommit(
      outerContext,
      () => {
        completedTasks.push("outer");
      },
    );
  });

  assert.deepEqual(completedTasks, ["outer"]);
});

test("withTransaction() rebinds adapter capabilities to the transaction", async () => {
  const rootDb = createFakeDb();
  const capabilityDbs: Database[] = [];
  const context = createContext(rootDb, capabilityDbs);

  await withTransaction(context, async (transactionContext) => {
    assert.notEqual(transactionContext.db, rootDb);
    assert.equal(transactionContext.rootDb, rootDb);
    assert.equal(transactionContext.services, context.services);
    await transactionContext.lookupObject("https://example.com/object");
    assert.deepEqual(capabilityDbs, [transactionContext.db]);
  });
});

test("withTransaction() does not fail committed work for an after-commit error", async () => {
  const context = createContext(createFakeDb());

  const result = await withTransaction(context, async (transactionContext) => {
    await queueAfterCommit(transactionContext, () => {
      throw new Error("best-effort task failed");
    });
    return "committed";
  });

  assert.equal(result, "committed");
});
