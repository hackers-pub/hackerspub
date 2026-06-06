import assert from "node:assert";
import test from "node:test";
import { parse } from "graphql";
import type { Plugin as EnvelopPlugin } from "graphql-yoga";
import postgres from "postgres";
import type { UserContext } from "./builder.ts";
import { useQuerySnapshotTransaction } from "./query-tx-plugin.ts";

function makePgError(code: string): postgres.PostgresError {
  const err = new postgres.PostgresError(`pg error ${code}`);
  // `code` is a writable property on PostgresError instances.
  (err as unknown as Record<string, unknown>).code = code;
  return err;
}

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

test("useQuerySnapshotTransaction wraps a query in REPEATABLE READ", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness("query Q { __typename }", "Q");

  await plugin.onExecute!(h.payload);
  assert.ok(
    typeof h.registeredExecute === "function",
    "expected setExecuteFn to be called",
  );

  const result = await h.registeredExecute!(h.payload.args);

  assert.deepEqual(h.txCalls.length, 1);
  assert.deepEqual(h.txCalls[0].config.isolationLevel, "repeatable read");
  // No `accessMode: "read only"` — query resolvers like `searchObject`
  // legitimately write (e.g. `addPostToTimeline`, `persistPost` through
  // `ctx.fedCtx`), and locking them out would regress those flows.
  assert.deepEqual(h.txCalls[0].config.accessMode, undefined);
  // Both ctx.db and ctx.fedCtx.data.db should observe the swap so any
  // model helper invoked via fedCtx (persistActor / persistPost / ...)
  // shares the transaction snapshot.
  assert.deepEqual(
    (h.innerExecuteSawCtxDb as { id?: string } | undefined)?.id,
    "tx",
  );
  assert.deepEqual(
    (h.innerExecuteSawFedDb as { id?: string } | undefined)?.id,
    "tx",
  );
  // The originals are restored once execute returns.
  assert.deepEqual(
    (h.payload.args.contextValue as unknown as { db: { id: string } }).db.id,
    "root-db",
  );
  assert.deepEqual(
    (h.fedData.db as { id?: string } | undefined)?.id,
    "root-db",
  );
  assert.deepEqual(
    (result as { data: { __typename: string } }).data.__typename,
    "Query",
  );
});

test("useQuerySnapshotTransaction restores db handles when execute throws", async () => {
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

  assert.ok(caught instanceof Error && caught.message === "boom");
  assert.deepEqual(
    (h.payload.args.contextValue as unknown as { db: { id: string } }).db.id,
    "root-db",
  );
  assert.deepEqual(
    (h.fedData.db as { id?: string } | undefined)?.id,
    "root-db",
  );
});

test("useQuerySnapshotTransaction does not wrap a mutation", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness("mutation M { __typename }", "M");

  await plugin.onExecute!(h.payload);

  assert.deepEqual(h.registeredExecute, undefined);
  assert.deepEqual(h.txCalls.length, 0);
});

test("useQuerySnapshotTransaction does not wrap a subscription", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness("subscription S { __typename }", "S");

  await plugin.onExecute!(h.payload);

  assert.deepEqual(h.registeredExecute, undefined);
  assert.deepEqual(h.txCalls.length, 0);
});

test("useQuerySnapshotTransaction selects the operation by name", async () => {
  const plugin = useQuerySnapshotTransaction();
  const source = `
    query Q { __typename }
    mutation M { __typename }
  `;

  const queryHarness = buildHarness(source, "Q");
  await plugin.onExecute!(queryHarness.payload);
  assert.ok(typeof queryHarness.registeredExecute === "function");

  const mutationHarness = buildHarness(source, "M");
  await plugin.onExecute!(mutationHarness.payload);
  assert.deepEqual(mutationHarness.registeredExecute, undefined);
});

test("useQuerySnapshotTransaction skips ambiguous documents", async () => {
  // Multiple operations + no operationName is an error for `graphql.execute`
  // to surface — we don't want to wrap anything in that case.
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness(
    `query Q { __typename } query R { __typename }`,
    null,
  );

  await plugin.onExecute!(h.payload);

  assert.deepEqual(h.registeredExecute, undefined);
  assert.deepEqual(h.txCalls.length, 0);
});

test("useQuerySnapshotTransaction handles an unnamed single query", async () => {
  const plugin = useQuerySnapshotTransaction();
  const h = buildHarness(`{ __typename }`, null);

  await plugin.onExecute!(h.payload);

  assert.ok(typeof h.registeredExecute === "function");
  await h.registeredExecute!(h.payload.args);
  assert.deepEqual(h.txCalls.length, 1);
});

test("useQuerySnapshotTransaction retries on serialization failure (40001)", async () => {
  const plugin = useQuerySnapshotTransaction();
  let calls = 0;
  const txCalls: number[] = [];
  const stubDb = {
    id: "root-db" as const,
    async transaction(
      cb: (tx: { readonly id: "tx" }) => Promise<unknown>,
      _config: { isolationLevel?: string },
    ): Promise<unknown> {
      const n = ++calls;
      txCalls.push(n);
      if (n === 1) throw makePgError("40001");
      return await cb({ id: "tx" });
    },
  };
  const fedData = { db: stubDb as unknown };
  const contextValue = {
    db: stubDb,
    fedCtx: { data: fedData },
  } as unknown as UserContext;
  let registeredExecute: ExecuteFn | undefined;
  const payload = {
    args: {
      document: parse("query Q { __typename }"),
      operationName: "Q",
      contextValue,
    } as unknown as OnExecutePayload["args"],
    executeFn: (async () => ({ data: { __typename: "Query" } })) as ExecuteFn,
    setExecuteFn(fn: ExecuteFn) {
      registeredExecute = fn;
    },
    setResultAndStopExecution() {},
    context: contextValue,
    extendContext() {},
  } as unknown as OnExecutePayload;

  await plugin.onExecute!(payload);
  assert.ok(typeof registeredExecute === "function");
  const result = await registeredExecute!(payload.args);

  assert.deepEqual(txCalls.length, 2, "should have retried once");
  assert.deepEqual(
    (result as { data: { __typename: string } }).data.__typename,
    "Query",
  );
});

test("useQuerySnapshotTransaction retries on deadlock (40P01)", async () => {
  const plugin = useQuerySnapshotTransaction();
  let calls = 0;
  const stubDb = {
    id: "root-db" as const,
    async transaction(
      cb: (tx: { readonly id: "tx" }) => Promise<unknown>,
      _config: { isolationLevel?: string },
    ): Promise<unknown> {
      if (++calls === 1) throw makePgError("40P01");
      return await cb({ id: "tx" });
    },
  };
  const fedData = { db: stubDb as unknown };
  const contextValue = {
    db: stubDb,
    fedCtx: { data: fedData },
  } as unknown as UserContext;
  let registeredExecute: ExecuteFn | undefined;
  const payload = {
    args: {
      document: parse("query Q { __typename }"),
      operationName: "Q",
      contextValue,
    } as unknown as OnExecutePayload["args"],
    executeFn: (async () => ({ data: { __typename: "Query" } })) as ExecuteFn,
    setExecuteFn(fn: ExecuteFn) {
      registeredExecute = fn;
    },
    setResultAndStopExecution() {},
    context: contextValue,
    extendContext() {},
  } as unknown as OnExecutePayload;

  await plugin.onExecute!(payload);
  assert.ok(typeof registeredExecute === "function");
  await registeredExecute!(payload.args);

  assert.deepEqual(calls, 2, "should have retried once after deadlock");
});

test("useQuerySnapshotTransaction gives up after maxRetries", async () => {
  const plugin = useQuerySnapshotTransaction({ maxRetries: 2 });
  let calls = 0;
  const stubDb = {
    id: "root-db" as const,
    async transaction(
      _cb: (tx: { readonly id: "tx" }) => Promise<unknown>,
      _config: { isolationLevel?: string },
    ): Promise<unknown> {
      calls++;
      throw makePgError("40001");
    },
  };
  const fedData = { db: stubDb as unknown };
  const contextValue = {
    db: stubDb,
    fedCtx: { data: fedData },
  } as unknown as UserContext;
  let registeredExecute: ExecuteFn | undefined;
  const payload = {
    args: {
      document: parse("query Q { __typename }"),
      operationName: "Q",
      contextValue,
    } as unknown as OnExecutePayload["args"],
    executeFn: (async () => ({ data: { __typename: "Query" } })) as ExecuteFn,
    setExecuteFn(fn: ExecuteFn) {
      registeredExecute = fn;
    },
    setResultAndStopExecution() {},
    context: contextValue,
    extendContext() {},
  } as unknown as OnExecutePayload;

  await plugin.onExecute!(payload);
  assert.ok(typeof registeredExecute === "function");
  await assert.rejects(
    () => registeredExecute!(payload.args),
    postgres.PostgresError,
  );

  assert.deepEqual(
    calls,
    3,
    "should have tried 3 times (1 initial + 2 retries)",
  );
});

test("useQuerySnapshotTransaction does not retry non-retryable errors", async () => {
  const plugin = useQuerySnapshotTransaction();
  let calls = 0;
  const stubDb = {
    id: "root-db" as const,
    async transaction(
      _cb: (tx: { readonly id: "tx" }) => Promise<unknown>,
      _config: { isolationLevel?: string },
    ): Promise<unknown> {
      calls++;
      throw new Error("some other error");
    },
  };
  const fedData = { db: stubDb as unknown };
  const contextValue = {
    db: stubDb,
    fedCtx: { data: fedData },
  } as unknown as UserContext;
  let registeredExecute: ExecuteFn | undefined;
  const payload = {
    args: {
      document: parse("query Q { __typename }"),
      operationName: "Q",
      contextValue,
    } as unknown as OnExecutePayload["args"],
    executeFn: (async () => ({ data: { __typename: "Query" } })) as ExecuteFn,
    setExecuteFn(fn: ExecuteFn) {
      registeredExecute = fn;
    },
    setResultAndStopExecution() {},
    context: contextValue,
    extendContext() {},
  } as unknown as OnExecutePayload;

  await plugin.onExecute!(payload);
  assert.ok(typeof registeredExecute === "function");
  await assert.rejects(
    () => registeredExecute!(payload.args),
    (e: unknown) =>
      e instanceof Error && e.message.includes("some other error"),
  );

  assert.deepEqual(calls, 1, "should not have retried a non-retryable error");
});
