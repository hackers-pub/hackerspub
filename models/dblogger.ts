import { getLogger } from "@logtape/logtape";
import type { Logger } from "drizzle-orm/logger";

export class DatabaseLogger implements Logger {
  readonly logger = getLogger("drizzle-orm");

  logQuery(query: string, params: unknown[]): void {
    const stringifiedParams = params.map(DatabaseLogger.serialize);
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
    if (typeof p === "string") return DatabaseLogger.stringLiteral(p);
    if (typeof p === "number" || typeof p === "bigint") return p.toString();
    if (typeof p === "boolean") return p ? "'t'" : "'f'";
    if (p instanceof Date) return DatabaseLogger.stringLiteral(p.toISOString());
    if (Array.isArray(p)) {
      return `ARRAY[${p.map(DatabaseLogger.serialize).join(", ")}]`;
    }
    if (typeof p === "object") {
      // Assume it's a JSON object
      return DatabaseLogger.stringLiteral(JSON.stringify(p));
    }
    return DatabaseLogger.stringLiteral(String(p));
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
