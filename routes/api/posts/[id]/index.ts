import { sql } from "drizzle-orm";
import { db } from "../../../../db.ts";
import { isPostVisibleTo } from "../../../../models/post.ts";
import { validateUuid } from "../../../../models/uuid.ts";
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
  if (post.sharedPost != null) post = { ...post.sharedPost, sharedPost: null };
  if (!isPostVisibleTo(post, account?.actor)) return ctx.next();
  return new Response(JSON.stringify(post), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
});
