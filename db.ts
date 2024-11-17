import "./logging.ts";
import { getLogger } from "@logtape/logtape";
import { neon, neonConfig } from "@neondatabase/serverless";
import { startSpan } from "@sentry/deno";
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
  return await startSpan(
    { op: "http.client", name: `${init.method ?? "GET"} ${url}` },
    async (span) => {
      const parsedUrl = new URL(url);
      span.setAttribute("http.query", parsedUrl.search);
      span.setAttribute("http.request.method", init.method ?? "GET");
      span.setAttribute("server.address", parsedUrl.hostname);
      span.setAttribute(
        "server.port",
        parsedUrl.port ? parseInt(parsedUrl.port) : undefined,
      );
      const response = await fetch(url, init);
      span.setAttribute("http.response.status_code", response.status);
      if (response.headers.has("content-length")) {
        span.setAttribute(
          "http.response.content_length",
          parseInt(response.headers.get("content-length")!),
        );
      }
      return response;
    },
  );
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
