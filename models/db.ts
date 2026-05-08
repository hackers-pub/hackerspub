import type { RelationsFilter as RelationsFilterImpl } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";
import type { relations } from "./relations.ts";

export type Database = PostgresJsDatabase<typeof relations>;

export type Transaction = PostgresJsTransaction<typeof relations>;

export type RelationsFilter<
  T extends keyof typeof relations,
> = RelationsFilterImpl<
  (typeof relations)[T],
  typeof relations
>;
