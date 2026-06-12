import { isPostVisibleTo } from "@hackerspub/models/post";
import { validateUuid } from "@hackerspub/models/uuid";
import { sql } from "drizzle-orm";
import {
  isPostCensoredFor,
  redactCensoredPost,
} from "../../../../censorship.ts";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const postId = ctx.params.id;
  if (!validateUuid(postId)) return ctx.next();
  const { account } = ctx.state;
  let post = await db.query.postTable.findFirst({
    with: {
      actor: {
        with: {
          followers: {
            where: account == null
              ? { RAW: sql`false` }
              : { followerId: account.actor.id },
          },
          blockees: {
            where: account == null
              ? { RAW: sql`false` }
              : { blockeeId: account.actor.id },
          },
          blockers: {
            where: account == null
              ? { RAW: sql`false` }
              : { blockerId: account.actor.id },
          },
        },
      },
      articleSource: true,
      mentions: { with: { actor: true } },
      media: {
        orderBy: { index: "asc" },
      },
      sharedPost: {
        with: {
          actor: {
            with: {
              followers: {
                where: account == null
                  ? { RAW: sql`false` }
                  : { followerId: account.actor.id },
              },
              blockees: {
                where: account == null
                  ? { RAW: sql`false` }
                  : { blockeeId: account.actor.id },
              },
              blockers: {
                where: account == null
                  ? { RAW: sql`false` }
                  : { blockerId: account.actor.id },
              },
            },
          },
          articleSource: true,
          mentions: { with: { actor: true } },
          media: {
            orderBy: { index: "asc" },
          },
        },
      },
    },
    where: { id: postId },
  });
  if (post == null) return ctx.next();
  // A censored share wrapper must not be unwrapped to the boosted post's
  // content; the redaction below clears the wrapper's `sharedPost` instead.
  if (post.sharedPost != null && !isPostCensoredFor(post, account)) {
    post = { ...post.sharedPost, sharedPost: null };
  }
  if (!isPostVisibleTo(post, account?.actor)) return ctx.next();
  // Censored posts stay reachable, but their content is replaced with a
  // notice for everyone except the author and moderators.
  if (isPostCensoredFor(post, account)) {
    post = redactCensoredPost(post, ctx.state.t);
  }
  return new Response(JSON.stringify(post), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
});
