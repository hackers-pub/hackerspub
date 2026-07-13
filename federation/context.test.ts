import { assertStrictEquals } from "@std/assert";
import type { Context } from "@fedify/fedify";
import type {
  ApplicationContext,
  ContextData,
} from "@hackerspub/models/context";
import { getFedifyContext } from "./context.ts";

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
