import type { RelationsFilter as RelationsFilterImpl } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";
import type { relations } from "./relations.ts";

export type Database = PostgresJsDatabase<typeof relations>;

export type Transaction = PostgresJsTransaction<typeof relations>;

export function isTransaction(
  db: Database | Transaction,
): db is Transaction {
  return "rollback" in db;
}

export async function runInTransaction<T>(
  db: Database | Transaction,
  run: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (isTransaction(db)) return await run(db);
  return await db.transaction(run);
}

export type RelationsFilter<
  T extends keyof typeof relations,
> = RelationsFilterImpl<
  (typeof relations)[T],
  typeof relations
>;
