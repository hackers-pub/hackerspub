import type { Database } from "@hackerspub/models/db";
import type { GraphQLResolveInfo, OperationDefinitionNode } from "graphql";
import type { UserContext } from "./builder.ts";

/** Keep request data separate across operations and snapshot retries. */
export function createRequestCache<T>(
  create: (ctx: UserContext, operation: OperationDefinitionNode) => T,
): (ctx: UserContext, info: Pick<GraphQLResolveInfo, "operation">) => T {
  const entries = new WeakMap<
    UserContext,
    { db: Database; operation: OperationDefinitionNode; value: T }
  >();
  return (ctx, info) => {
    let entry = entries.get(ctx);
    if (entry?.db !== ctx.db || entry?.operation !== info.operation) {
      entry = {
        db: ctx.db,
        operation: info.operation,
        value: create(ctx, info.operation),
      };
      entries.set(ctx, entry);
    }
    return entry.value;
  };
}
