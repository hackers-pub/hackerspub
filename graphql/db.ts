import type { Database } from "@hackerspub/models/db";
import { relations } from "@hackerspub/models/relations";
import * as schema from "@hackerspub/models/schema";
import { getLogger as getDatabaseLogger } from "@logtape/drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { drizzle } from "drizzle-orm/postgres-js";
import postgresJs from "postgres";
import "./logging.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (DATABASE_URL == null) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

export const postgres = postgresJs(DATABASE_URL, {
  // The pool size needs to exceed the ParallelMessageQueue concurrency (10)
  // to leave headroom for HTTP handlers and KV store queries.  The default
  // of 10 can cause connection starvation under federation load.
  max: 20,
});
export const db: Database = drizzle({
  schema,
  relations,
  client: postgres,
  logger: getDatabaseLogger(),
});
getLogger(["hackerspub", "db"])
  .debug("The driver is ready: {driver}", { driver: db.constructor });
