import { getLogger } from "@logtape/logtape";
import type { AfterCommitTask, ApplicationContext } from "./context.ts";
import type { Database, Transaction } from "./db.ts";

const logger = getLogger(["hackerspub", "models", "transaction"]);

export async function queueAfterCommit<D extends Database>(
  context: Pick<ApplicationContext<D>, "afterCommit">,
  task: AfterCommitTask,
): Promise<void> {
  const afterCommit = context.afterCommit;
  if (afterCommit != null) {
    afterCommit.push(task);
    return;
  }
  await task();
}

export async function withTransaction<T>(
  context: ApplicationContext,
  callback: (context: ApplicationContext<Transaction>) => Promise<T>,
) {
  const parentAfterCommit = context.afterCommit;
  const afterCommit: AfterCommitTask[] = [];
  const rootDb = context.rootDb ?? context.db;
  const result = await context.db.transaction(async (transaction) => {
    const nextContext: ApplicationContext<Transaction> = {
      ...context.withDatabase(transaction),
      db: transaction,
      rootDb,
      afterCommit,
    };
    return await callback(nextContext);
  });
  if (parentAfterCommit != null) {
    parentAfterCommit.push(...afterCommit);
  } else {
    for (const task of afterCommit) {
      try {
        await task();
      } catch (error) {
        logger.error("Failed to run after-commit task: {error}", { error });
      }
    }
  }
  return result;
}

export function transactional<Arguments extends unknown[], Result>(
  operation: (
    context: ApplicationContext,
    ...args: Arguments
  ) => Promise<Result>,
): (context: ApplicationContext, ...args: Arguments) => Promise<Result> {
  return async (context, ...args) =>
    await withTransaction(
      context,
      async (transactionContext) =>
        await operation(transactionContext, ...args),
    );
}
