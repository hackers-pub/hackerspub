import { page } from "fresh";
import { compileQuery, type Expr } from "../../models/search.ts";
import { define } from "../../utils.ts";
import SearchResults, { search, type SearchResultsProps } from "../search.tsx";

export const handler = define.handlers(async (ctx) => {
  const expr: Expr = { type: "hashtag", hashtag: ctx.params.tag };
  const posts = await search(ctx.state.account, compileQuery(expr));
  ctx.state.searchQuery = `#${ctx.params.tag}`;
  return page<SearchResultsProps>({ posts });
});

export default SearchResults;
