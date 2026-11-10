import { sql } from "drizzle-orm";
import type { Database, RelationsFilter, Transaction } from "./db.ts";
import { postHashtagTable, postTable } from "./schema.ts";
import type { Expr } from "./search.ts";
import type { Uuid } from "./uuid.ts";

/**
 * Compile the parsed expression without adding viewer or pagination filters.
 * The default materializes hashtag membership to protect sparse-tag searches
 * from long publication-index scans. Enable `hashtagRecheck` only after an
 * indexed candidate relation narrows membership: the equivalent function
 * predicate avoids a second GIN path that can be rescanned for each actor.
 */
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

/**
 * Return normalized, distinct tags required by the entire expression.
 * Only descend through conjunctions: an OR branch or negated term alone cannot
 * safely restrict every result to posts with that tag.
 */
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

/**
 * Select IDs and cursor dates before hydrating search results, applying all
 * filters before the page limit. Required tags use the ordered relation; other
 * expressions retain the fenced generic query. Pass a limit including any
 * connection lookahead; `until` bounds both the source and candidate dates.
 */
export async function getSearchPostPage(
  db: Database | Transaction,
  expr: Expr,
  commonFilter: RelationsFilter<"postTable">,
  options: { limit: number; until?: Date },
): Promise<{ id: Uuid; published: Date }[]> {
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
      columns: { id: true, published: true },
      where,
      orderBy: { published: "desc" },
      limit: options.limit,
    });
  }

  const page = await db.query.postHashtagTable.findMany({
    columns: { postId: true, published: true },
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
  return page.map(({ postId, published }) => ({ id: postId, published }));
}
