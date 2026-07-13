import type { Database } from "@hackerspub/models/db";
import { type DocumentNode, Kind, type OperationDefinitionNode } from "graphql";
import type { Plugin as EnvelopPlugin } from "graphql-yoga";
import postgres from "postgres";
import type { UserContext } from "./builder.ts";

// Wrap GraphQL query operations in a single PostgreSQL REPEATABLE READ
// transaction so every SELECT issued during resolution — including
// Pothos drizzle's "smart" re-fetches across the Drizzle RQB v2
// multi-query joins — sees the same snapshot.
//
// Why this exists: Drizzle's RQB v2 (`defineRelations`) splits a single
// `findMany({ with: { actor: ... } })` into multiple SELECTs.  Under
// READ COMMITTED, a cascade DELETE that commits between those SELECTs
// can leave a parent row visible with its related row missing, producing
// `Cannot return null for non-nullable field …actor` errors when Pothos
// re-fetches a Post during nested-field resolution (the timeline model
// already sanitizes its own initial fetch but cannot help with Pothos's
// later re-fetches).  A snapshot for the whole request prevents that.
//
// We deliberately do NOT pass `accessMode: "read only"` even though most
// query operations only read.  A handful of query resolvers (e.g.
// `searchObject` calling `addPostToTimeline`, or any path that goes
// through `persistActor`/`persistPost` via `ctx.fedCtx`) intentionally
// write as a side effect.  A read-only transaction would reject those.
// REPEATABLE READ alone still gives us the consistent snapshot we need
// — writes done inside the transaction are visible to subsequent reads
// in the same transaction.
//
// Mutations and subscriptions stay on the driver's default (autocommit,
// READ COMMITTED).  Mutations want to see freshly-committed data from
// concurrent writers; subscriptions are long-lived streams where pinning
// a snapshot would defeat their purpose.
// PostgreSQL error codes that indicate the transaction conflicted with a
// concurrent writer and should be retried from scratch.  Both codes are
// documented in the PostgreSQL Error Codes appendix.
//
// 40001 — serialization_failure: raised by REPEATABLE READ when the
//   snapshot detects that the committed data it read has been modified by
//   another transaction since the snapshot was taken.
// 40P01 — deadlock_detected: raised when the server breaks a deadlock by
//   aborting one of the involved transactions.
const RETRYABLE_PG_CODES = new Set(["40001", "40P01"]);

export function isRetryableError(err: unknown): boolean {
  return err instanceof postgres.PostgresError &&
    RETRYABLE_PG_CODES.has(err.code);
}

export function useQuerySnapshotTransaction(
  { maxRetries = 3 }: { maxRetries?: number } = {},
): EnvelopPlugin<UserContext> {
  return {
    onExecute({ args, executeFn, setExecuteFn }) {
      if (!isReadOnlyOperation(args.document, args.operationName)) return;

      // Capture the executeFn at the point our plugin runs so we layer on
      // top of whatever earlier plugins (e.g. the NO_PROPAGATE wrapper)
      // have set up, rather than re-invoking `graphql.execute` directly
      // and dropping their configuration.
      const wrappedExecute = executeFn;
      const ctx = args.contextValue as UserContext;
      const rootDb = ctx.db;

      setExecuteFn(async (innerArgs) => {
        let attempt = 0;
        while (true) {
          try {
            return await rootDb.transaction(
              async (tx) => {
                // Swap every database handle reachable through the context so
                // both direct Drizzle access (`ctx.db` for resolvers and
                // Pothos drizzle's re-fetches, via the schema's
                // `drizzle.client: (ctx) => ctx.db` factory) and federation
                // helpers share the same snapshot.  Rebinding the complete
                // application context is necessary because methods such as
                // `lookupObject` and `sendActivity` close over the underlying
                // Fedify context and its `data.db`; changing only `fedCtx.db`
                // leaves those methods on the root pool.  `contextValue` is
                // typed `Readonly` by envelop, but at runtime it is the same
                // object resolvers consume, and per-request mutation is the
                // standard envelop pattern for request-scoped overrides.
                const liveCtx = innerArgs
                  .contextValue as unknown as UserContext;
                const originalDb = liveCtx.db;
                const originalFedCtx = liveCtx.fedCtx;
                // Cast: PostgresJsTransaction structurally satisfies the
                // PostgresJsDatabase interface (both extend PgAsyncDatabase),
                // but Drizzle's nominal class typing makes TypeScript reject
                // direct assignment.  The runtime contract is identical for
                // every method Pothos and resolvers call.
                const txAsDb = tx as unknown as Database;
                liveCtx.db = txAsDb;
                liveCtx.fedCtx = originalFedCtx.withDatabase(txAsDb);
                try {
                  return await wrappedExecute(innerArgs);
                } finally {
                  liveCtx.db = originalDb;
                  liveCtx.fedCtx = originalFedCtx;
                }
              },
              { isolationLevel: "repeatable read" },
            );
          } catch (err) {
            if (isRetryableError(err) && attempt < maxRetries) {
              attempt++;
              continue;
            }
            throw err;
          }
        }
      });
    },
  };
}

function isReadOnlyOperation(
  document: DocumentNode,
  operationName: string | null | undefined,
): boolean {
  const operations = document.definitions.filter(
    (def): def is OperationDefinitionNode =>
      def.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length === 0) return false;

  // Match GraphQL's own operation selection: by name when provided,
  // otherwise the lone operation (a document with multiple operations and
  // no operationName is a client error that `graphql.execute` will surface
  // on its own — we don't try to second-guess it).
  const operation = operationName == null
    ? operations.length === 1 ? operations[0] : undefined
    : operations.find((op) => op.name?.value === operationName);

  return operation?.operation === "query";
}
