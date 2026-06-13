import { vote } from "@hackerspub/models/poll";
import { isPostVisibleTo } from "@hackerspub/models/post";
import { validateUuid } from "@hackerspub/models/uuid";
import { isPostCensoredFor } from "../../../../censorship.ts";
import { define } from "../../../../utils.ts";
import { getPost } from "./poll.ts";

export const handler = define.handlers(async (ctx) => {
  if (!validateUuid(ctx.params.id) || ctx.state.account == null) {
    return ctx.next();
  }
  let post = await getPost(ctx.params.id, ctx.state.account);
  if (post == null || post.type !== "Question") return ctx.next();
  if (!isPostVisibleTo(post, ctx.state.account?.actor)) return ctx.next();
  // A censored question cannot be voted on, and its options/counts must not
  // leak; mirror the poll-fetch endpoint's guard (the author and moderators
  // are exempt, matching isPostCensoredFor).
  if (isPostCensoredFor(post, ctx.state.account)) return ctx.next();
  if (post.poll == null) return ctx.next();
  const indices: number[] = await ctx.req.json();
  if (
    !Array.isArray(indices) || indices.some((i) => typeof i !== "number") ||
    indices.length < 1
  ) {
    return ctx.next();
  }
  const optionIndices = new Set(indices);
  await vote(
    ctx.state.fedCtx,
    ctx.state.account,
    post.poll,
    optionIndices,
  );
  post = await getPost(ctx.params.id, ctx.state.account);
  return new Response(
    JSON.stringify(post!.poll),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
});
