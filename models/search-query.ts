import { sql } from "drizzle-orm";
import type { Database, RelationsFilter, Transaction } from "./db.ts";
import { postHashtagTable, postTable } from "./schema.ts";
import type { Expr } from "./search.ts";
import type { Uuid } from "./uuid.ts";

export function compileQuery(
  expr: Expr,
  hashtagRecheck = false,
): RelationsFilter<"postTable"> {
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
      if (hashtagRecheck) {
        return {
          // This is the function behind `?`, with identical semantics, but
          // PostgreSQL cannot match it to the tags GIN index. The ordered
          // candidate relation already narrows tags; a second GIN path can
          // otherwise be rescanned once per actor after decorrelation.
          RAW: (t) =>
            sql`jsonb_exists(${t.tags}, ${expr.hashtag.toLowerCase()})`,
        };
      }
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
        AND: [
          compileQuery(expr.left, hashtagRecheck),
          compileQuery(expr.right, hashtagRecheck),
        ],
      };
    case "or":
      return {
        OR: [
          compileQuery(expr.left, hashtagRecheck),
          compileQuery(expr.right, hashtagRecheck),
        ],
      };
    case "not":
      return { NOT: compileQuery(expr.expr, hashtagRecheck) };
  }
}

/** Tags that every matching post must have, without expanding OR branches. */
export function getRequiredHashtags(expr: Expr): string[] {
  switch (expr.type) {
    case "hashtag":
      return [expr.hashtag.toLowerCase()];
    case "and":
      return [
        ...new Set([
          ...getRequiredHashtags(expr.left),
          ...getRequiredHashtags(expr.right),
        ]),
      ];
    default:
      return [];
  }
}

/** Select IDs before hydrating search results, preserving the generic fallback. */
export async function getSearchPostPage(
  db: Database | Transaction,
  expr: Expr,
  commonFilter: RelationsFilter<"postTable">,
  options: { limit: number; until?: Date },
): Promise<{ id: Uuid }[]> {
  const hashtags = getRequiredHashtags(expr);
  const where: RelationsFilter<"postTable"> = {
    AND: [
      commonFilter,
      compileQuery(expr, hashtags.length > 0),
      options.until == null ? {} : { published: { lte: options.until } },
    ],
  };
  if (hashtags.length < 1) {
    return await db.query.postTable.findMany({
      columns: { id: true },
      where,
      orderBy: { published: "desc" },
      limit: options.limit,
    });
  }

  const page = await db.query.postHashtagTable.findMany({
    columns: { postId: true },
    where: {
      AND: [
        { RAW: (t) => sql`${t.tagHash} = md5(${hashtags[0]})::uuid` },
        // Intersect all required tags in the candidate relation, allowing
        // the planner to start with a sparse tag even when it is written last.
        ...hashtags.slice(1).map(
          (tag): RelationsFilter<"postHashtagTable"> => ({
            RAW: (t) => sql`${t.postId} IN (
              SELECT ${postHashtagTable.postId} FROM ${postHashtagTable}
              WHERE ${postHashtagTable.tagHash} = md5(${tag})::uuid
            )`,
          }),
        ),
        options.until == null ? {} : { published: { lte: options.until } },
        { post: where },
      ],
    },
    orderBy: { published: "desc" },
    limit: options.limit,
  });
  return page.map(({ postId }) => ({ id: postId }));
}
