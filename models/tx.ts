import type { RequestContext } from "@fedify/fedify";
import type { AfterCommitTask, ContextData } from "./context.ts";
import type { Database, Transaction } from "./db.ts";

export async function queueAfterCommit<D extends Database>(
  context: { data: ContextData<D> },
  task: AfterCommitTask,
): Promise<void> {
  const afterCommit = context.data.afterCommit;
  if (afterCommit != null) {
    afterCommit.push(task);
    return;
  }
  await task();
}

export async function withTransaction<T>(
  context: RequestContext<ContextData>,
  callback: (context: RequestContext<ContextData<Transaction>>) => Promise<T>,
) {
  const parentAfterCommit = context.data.afterCommit;
  const afterCommit: AfterCommitTask[] = [];
  const rootDb = context.data.rootDb ?? context.data.db;
  const result = await context.data.db.transaction(async (transaction) => {
    const nextContext = context.federation.createContext(context.request, {
      ...context.data,
      db: transaction,
      rootDb,
      afterCommit,
    }) as RequestContext<ContextData<Transaction>>;
    return await callback(nextContext);
  });
  if (parentAfterCommit != null) {
    parentAfterCommit.push(...afterCommit);
  } else {
    for (const task of afterCommit) await task();
  }
  return result;
}
