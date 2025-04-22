import type { Database } from "@hackerspub/models/db";
import { relations } from "@hackerspub/models/relations";
import * as schema from "@hackerspub/models/schema";
import { getLogger } from "@logtape/logtape";
import type { Logger } from "drizzle-orm/logger";
import { drizzle } from "drizzle-orm/postgres-js";
import postgresJs from "postgres";
import "./logging.ts";

class LogTapeLogger implements Logger {
  readonly logger = getLogger("drizzle-orm");

  logQuery(query: string, params: unknown[]): void {
    const stringifiedParams = params.map(LogTapeLogger.serialize);
    const formattedQuery = query.replace(/\$(\d+)/g, (m) => {
      const index = Number.parseInt(m.slice(1), 10);
      return stringifiedParams[index - 1];
    });
    this.logger.debug("Query: {formattedQuery}", {
      formattedQuery,
      query,
      params,
    });
  }

  static serialize(p: unknown): string {
    if (typeof p === "undefined" || p === null) return "NULL";
    if (typeof p === "string") return LogTapeLogger.stringLiteral(p);
    if (typeof p === "number" || typeof p === "bigint") return p.toString();
    if (typeof p === "boolean") return p ? "'t'" : "'f'";
    if (p instanceof Date) return LogTapeLogger.stringLiteral(p.toISOString());
    if (Array.isArray(p)) {
      return `ARRAY[${p.map(LogTapeLogger.serialize).join(", ")}]`;
    }
    if (typeof p === "object") {
      // Assume it's a JSON object
      return LogTapeLogger.stringLiteral(JSON.stringify(p));
    }
    return LogTapeLogger.stringLiteral(String(p));
  }

  static stringLiteral(s: string) {
    if (/\\'\n\r\t\b\f/.exec(s)) {
      let str = s;
      str = str.replaceAll("\\", "\\\\");
      str = str.replaceAll("'", "\\'");
      str = str.replaceAll("\n", "\\n");
      str = str.replaceAll("\r", "\\r");
      str = str.replaceAll("\t", "\\t");
      str = str.replaceAll("\b", "\\b");
      str = str.replaceAll("\f", "\\f");
      return `E'${str}'`;
    }
    return `'${s}'`;
  }
}

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (DATABASE_URL == null) {
  throw new Error("Missing DATABASE_URL environment variable.");
}

export const postgres = postgresJs(DATABASE_URL);
export const db: Database = drizzle({
  schema,
  relations,
  client: postgres,
  logger: new LogTapeLogger(),
});
getLogger(["hackerspub", "db"])
  .debug("The driver is ready: {driver}", { driver: db.constructor });
