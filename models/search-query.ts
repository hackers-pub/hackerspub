import { sql } from "drizzle-orm";
import type { RelationsFilter } from "./db.ts";
import { postTable } from "./schema.ts";
import type { Expr } from "./search.ts";

export function compileQuery(expr: Expr): RelationsFilter<"postTable"> {
  switch (expr.type) {
    case "keyword":
      return { contentHtml: { ilike: `%${expr.keyword}%` } };
    case "language":
      return { language: expr.language };
    case "actor":
      return {
        actor: {
          username: expr.username,
          ...(expr.host == null
            ? { accountId: { isNotNull: true } }
            : {
                OR: [{ instanceHost: expr.host }, { handleHost: expr.host }],
              }),
        },
      };
    case "hashtag":
      return {
        RAW(t) {
          const candidates = sql.identifier("hashtag_candidates");
          return sql`${t.id} IN (
            WITH ${candidates} AS MATERIALIZED (
              SELECT ${postTable.id}
              FROM ${postTable}
              WHERE ${postTable.tags} ? ${expr.hashtag.toLowerCase()}
            )
            SELECT ${sql.identifier("id")} FROM ${candidates}
          )`;
        },
      };
    case "and":
      return {
        AND: [compileQuery(expr.left), compileQuery(expr.right)],
      };
    case "or":
      return {
        OR: [compileQuery(expr.left), compileQuery(expr.right)],
      };
    case "not":
      return { NOT: compileQuery(expr.expr) };
  }
}
