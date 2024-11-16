import "./logging.ts";
import { getLogger } from "@logtape/logtape";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  drizzle as drizzlePostgres,
  type PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import {
  drizzle as drizzleNeon,
  type NeonQueryResultHKT,
} from "drizzle-orm/neon-serverless";
import postgresJs from "postgres";
import * as schema from "./models/schema.ts";

export type Database = PgDatabase<
  PostgresJsQueryResultHKT | NeonQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (DATABASE_URL == null) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

export const postgres = postgresJs(DATABASE_URL);
export const db: Database = new URL(DATABASE_URL).host.endsWith(".neon.tech")
  ? drizzleNeon({
    schema,
    connection: DATABASE_URL,
  })
  : drizzlePostgres({
    schema,
    client: postgres,
  });
getLogger(["hackerspub", "db"])
  .debug("The driver is ready: {driver}", { driver: db.constructor });
