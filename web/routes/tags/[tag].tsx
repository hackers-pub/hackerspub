import { page } from "@fresh/core";
import { compileQuery, type Expr } from "@hackerspub/models/search";
import { validateUuid } from "@hackerspub/models/uuid";
import { define } from "../../utils.ts";
import SearchResults, { search, type SearchResultsProps } from "../search.tsx";

export const handler = define.handlers(async (ctx) => {
  const continuation = ctx.url.searchParams.get("cont");
  const expr: Expr = { type: "hashtag", hashtag: ctx.params.tag };
  const { posts, continuation: next } = await search(
    ctx.state.account,
    compileQuery(expr),
    validateUuid(continuation) ? continuation : undefined,
  );
  ctx.state.searchQuery = `#${ctx.params.tag}`;
  let nextHref: URL | undefined;
  if (next != null) {
    nextHref = new URL(ctx.url);
    nextHref.searchParams.set("cont", next);
  }
  return page<SearchResultsProps>({ posts, nextHref });
});

export default SearchResults;
