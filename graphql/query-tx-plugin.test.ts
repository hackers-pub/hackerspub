import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { parse } from "graphql";
import type { Plugin as EnvelopPlugin } from "graphql-yoga";
import type { UserContext } from "./builder.ts";
import { useQuerySnapshotTransaction } from "./query-tx-plugin.ts";

type OnExecuteHook = NonNullable<EnvelopPlugin<UserContext>["onExecute"]>;
type OnExecutePayload = Parameters<OnExecuteHook>[0];
type ExecuteFn = OnExecutePayload["executeFn"];

interface StubDb {
  readonly id: "root-db";
  transaction(
    cb: (tx: { readonly id: "tx" }) => Promise<unknown>,
    config: { isolationLevel?: string; accessMode?: string },
  ): Promise<unknown>;
}

interface Harness {
  readonly stubDb: StubDb;
  readonly txCalls: Array<
    { config: { isolationLevel?: string; accessMode?: string } }
  >;
  readonly fedData: { db: unknown };
  readonly payload: OnExecutePayload;
  registeredExecute: ExecuteFn | undefined;
  innerExecuteSawCtxDb?: unknown;
  innerExecuteSawFedDb?: unknown;
}

function buildHarness(
  documentSource: string,
  operationName: string | null = null,
): Harness {
  const txCalls: Harness["txCalls"] = [];
  const stubDb: StubDb = {
    id: "root-db",
    async transaction(cb, config) {
      txCalls.push({ config });
      return await cb({ id: "tx" });
    },
  };
  const fedData = { db: stubDb as unknown };
  const contextValue = {
    db: stubDb,
    fedCtx: { data: fedData },
  } as unknown as UserContext;
  const harness: Harness = {
    stubDb,
    txCalls,
    fedData,
    registeredExecute: undefined,
    payload: {
      args: {
        document: parse(documentSource),
        operationName,
        contextValue,
        // The remaining fields are unused by the plugin under test.
      } as unknown as OnExecutePayload["args"],
      executeFn: (async (args) => {
        const innerCtx = args.contextValue as unknown as {
          db: unknown;
          fedCtx: { data: { db: unknown } };
        };
        harness.innerExecuteSawCtxDb = innerCtx.db;
        harness.innerExecuteSawFedDb = innerCtx.fedCtx.data.db;
        return { data: { __typename: "Query" } };
      }) as ExecuteFn,
      setExecuteFn(fn: ExecuteFn) {
        harness.registeredExecute = fn;
      },
      setResultAndStopExecution() {
        throw new Error("setResultAndStopExecution should not be called");
      },
      context: contextValue,
      extendContext() {
        throw new Error("extendContext should not be called");
      },
    } as unknown as OnExecutePayload,
  };
  return harness;
}

Deno.test("useQuerySnapshotTransaction wraps a query in REPEATABLE READ", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness("query Q { __typename }", "Q");

  await plugin.onExecute!(h.payload);
  assert(
    typeof h.registeredExecute === "function",
    "expected setExecuteFn to be called",
  );

  const result = await h.registeredExecute!(h.payload.args);

  assertEquals(h.txCalls.length, 1);
  assertEquals(h.txCalls[0].config.isolationLevel, "repeatable read");
  // No `accessMode: "read only"` — query resolvers like `searchObject`
  // legitimately write (e.g. `addPostToTimeline`, `persistPost` through
  // `ctx.fedCtx`), and locking them out would regress those flows.
  assertEquals(h.txCalls[0].config.accessMode, undefined);
  // Both ctx.db and ctx.fedCtx.data.db should observe the swap so any
  // model helper invoked via fedCtx (persistActor / persistPost / ...)
  // shares the transaction snapshot.
  assertEquals(
    (h.innerExecuteSawCtxDb as { id?: string } | undefined)?.id,
    "tx",
  );
  assertEquals(
    (h.innerExecuteSawFedDb as { id?: string } | undefined)?.id,
    "tx",
  );
  // The originals are restored once execute returns.
  assertEquals(
    (h.payload.args.contextValue as unknown as { db: { id: string } }).db.id,
    "root-db",
  );
  assertEquals((h.fedData.db as { id?: string } | undefined)?.id, "root-db");
  assertEquals(
    (result as { data: { __typename: string } }).data.__typename,
    "Query",
  );
});

Deno.test("useQuerySnapshotTransaction restores db handles when execute throws", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness("query Q { __typename }", "Q");
  h.payload.executeFn = (() => {
    throw new Error("boom");
  }) as ExecuteFn;

  await plugin.onExecute!(h.payload);

  let caught: unknown;
  try {
    await h.registeredExecute!(h.payload.args);
  } catch (e) {
    caught = e;
  }

  assert(caught instanceof Error && caught.message === "boom");
  assertEquals(
    (h.payload.args.contextValue as unknown as { db: { id: string } }).db.id,
    "root-db",
  );
  assertEquals((h.fedData.db as { id?: string } | undefined)?.id, "root-db");
});

Deno.test("useQuerySnapshotTransaction does not wrap a mutation", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness("mutation M { __typename }", "M");

  await plugin.onExecute!(h.payload);

  assertEquals(h.registeredExecute, undefined);
  assertEquals(h.txCalls.length, 0);
});

Deno.test("useQuerySnapshotTransaction does not wrap a subscription", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness("subscription S { __typename }", "S");

  await plugin.onExecute!(h.payload);

  assertEquals(h.registeredExecute, undefined);
  assertEquals(h.txCalls.length, 0);
});

Deno.test("useQuerySnapshotTransaction selects the operation by name", async () => {
  const plugin = useQuerySnapshotTransaction();
  const source = `
    query Q { __typename }
    mutation M { __typename }
  `;

  const queryHarness = buildHarness(source, "Q");
  await plugin.onExecute!(queryHarness.payload);
  assert(typeof queryHarness.registeredExecute === "function");

  const mutationHarness = buildHarness(source, "M");
  await plugin.onExecute!(mutationHarness.payload);
  assertEquals(mutationHarness.registeredExecute, undefined);
});

Deno.test("useQuerySnapshotTransaction skips ambiguous documents", async () => {
  // Multiple operations + no operationName is an error for `graphql.execute`
  // to surface — we don't want to wrap anything in that case.
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness(
    `query Q { __typename } query R { __typename }`,
    null,
  );

  await plugin.onExecute!(h.payload);

  assertEquals(h.registeredExecute, undefined);
  assertEquals(h.txCalls.length, 0);
});

Deno.test("useQuerySnapshotTransaction handles an unnamed single query", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness(`{ __typename }`, null);

  await plugin.onExecute!(h.payload);

  assert(typeof h.registeredExecute === "function");
  await h.registeredExecute!(h.payload.args);
  assertEquals(h.txCalls.length, 1);
});
