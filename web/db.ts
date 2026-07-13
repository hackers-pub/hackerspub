import type { Database } from "@hackerspub/models/db";
import type { Sql } from "postgres";

export let db: Database;
export let postgres: Sql;

export function configureDatabase(resources: {
  readonly db: Database;
  readonly postgres: Sql;
}): void {
  db = resources.db;
  postgres = resources.postgres;
}
