import type {
  ExtractTablesWithRelations,
  RelationsFilter as RelationsFilterImpl,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type * as schema from "./schema.ts";
import type { relations } from "./relations.ts";

export type Database = PgDatabase<
  PostgresJsQueryResultHKT,
  typeof schema,
  typeof relations
>;
export type RelationsFilter<
  T extends keyof ExtractTablesWithRelations<typeof relations>,
> = RelationsFilterImpl<
  ExtractTablesWithRelations<typeof relations>[T],
  ExtractTablesWithRelations<typeof relations>
>;
