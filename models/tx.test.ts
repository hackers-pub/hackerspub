import assert from "node:assert";
import test from "node:test";
import type { RequestContext } from "@fedify/fedify";
import type { ContextData } from "./context.ts";
import type { Database } from "./db.ts";
import { queueAfterCommit, withTransaction } from "./tx.ts";

function createFakeDb(): Database {
  const db = {
    transaction: async <T>(callback: (tx: Database) => Promise<T>) =>
      await callback(createFakeDb()),
  } as Database;
  return db;
}

function createContext(db: Database): RequestContext<ContextData> {
  const request = new Request("http://localhost/");
  const federation = {
    createContext(
      nextRequest: Request,
      data: ContextData,
    ): RequestContext<ContextData> {
      return {
        data,
        federation,
        request: nextRequest,
      } as RequestContext<ContextData>;
    },
  } as RequestContext<ContextData>["federation"];
  return federation.createContext(request, {
    db,
    disk: {} as never,
    kv: {} as never,
    models: {} as never,
    services: {} as never,
  });
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
