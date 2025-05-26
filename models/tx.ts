import type { RequestContext } from "@fedify/fedify";
import type { ContextData } from "./context.ts";
import type { Transaction } from "./db.ts";

export async function withTransaction<T>(
  context: RequestContext<ContextData>,
  callback: (context: RequestContext<ContextData<Transaction>>) => Promise<T>,
) {
  return await context.data.db.transaction(async (transaction) => {
    const nextContext = context.federation.createContext(context.request, {
      ...context.data,
      db: transaction,
    }) as RequestContext<ContextData<Transaction>>;
    return await callback(nextContext);
  });
}
