import type { Database } from "@hackerspub/models/db";
import { DatabaseLogger } from "@hackerspub/models/dblogger";
import { relations } from "@hackerspub/models/relations";
import * as schema from "@hackerspub/models/schema";
import { getLogger } from "@logtape/logtape";
import { drizzle } from "drizzle-orm/postgres-js";
import postgresJs from "postgres";
import "./logging.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (DATABASE_URL == null) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

export const postgres = postgresJs(DATABASE_URL);
export const db: Database = drizzle({
  schema,
  relations,
  client: postgres,
  logger: new DatabaseLogger(),
});
getLogger(["hackerspub", "db"])
  .debug("The driver is ready: {driver}", { driver: db.constructor });
