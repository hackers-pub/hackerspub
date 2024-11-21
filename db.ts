import "./logging.ts";
import { getLogger } from "@logtape/logtape";
import { neon, neonConfig } from "@neondatabase/serverless";
import { trace } from "@opentelemetry/api";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  drizzle as drizzlePostgres,
  type PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import {
  drizzle as drizzleNeon,
  type NeonHttpQueryResultHKT,
} from "drizzle-orm/neon-http";
import postgresJs from "postgres";
import * as schema from "./models/schema.ts";

export type Database = PgDatabase<
  PostgresJsQueryResultHKT | NeonHttpQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (DATABASE_URL == null) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

neonConfig.fetchFunction = async (url: string | URL, init: RequestInit) => {
  const tracer = trace.getTracer("@neondatabase/serverless");
  return await tracer.startActiveSpan("postgresql", async (span) => {
    span.setAttribute("db.system", "postgresql");
    if (typeof init.body === "string") {
      const body = JSON.parse(init.body);
      if (typeof body === "object" && body != null) {
        if (typeof body.query === "string") {
          span.setAttribute("db.query.text", body.query);
        }
        if (Array.isArray(body.params)) {
          for (let i = 0; i < body.params.length; i++) {
            span.setAttribute(`db.query.parameter.${i}`, body.params[i]);
          }
        }
      }
    }
    const headers = new Headers(init.headers);
    if (headers.has("Neon-Connection-String")) {
      const url = new URL(headers.get("Neon-Connection-String") ?? "");
      span.setAttribute("server.address", url.hostname);
      if (url.port !== "") span.setAttribute("server.port", url.port);
    }
    const response = await fetch(url, init);
    const result = await response.clone().json();
    if (typeof result === "object" && result != null) {
      if (typeof result.command === "string") {
        span.setAttribute("db.operation.name", result.command);
        span.updateName(result.command);
      }
    }
    span.end();
    return response;
  });
};

export const postgres = postgresJs(DATABASE_URL);
export const db: Database = new URL(DATABASE_URL).host.endsWith(".neon.tech")
  ? drizzleNeon({
    schema,
    client: neon(DATABASE_URL),
  })
  : drizzlePostgres({
    schema,
    client: postgres,
  });
getLogger(["hackerspub", "db"])
  .debug("The driver is ready: {driver}", { driver: db.constructor });
