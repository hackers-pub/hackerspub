import { isPostVisibleTo } from "@hackerspub/models/post";
import { validateUuid } from "@hackerspub/models/uuid";
import { sql } from "drizzle-orm";
import { db } from "../../../../../db.ts";
import { drive } from "../../../../../drive.ts";
import { define } from "../../../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const postId = ctx.params.id;
  const index = parseInt(ctx.params.index);
  if (!validateUuid(postId) || !Number.isSafeInteger(index)) return ctx.next();
  const post = await db.query.postTable.findFirst({
    where: { id: postId },
    with: {
      actor: {
        with: {
          followers: {
            where: ctx.state.account == null
              ? { RAW: sql`false` }
              : { followerId: ctx.state.account.actor.id },
          },
          blockees: {
            where: ctx.state.account == null
              ? { RAW: sql`false` }
              : { blockeeId: ctx.state.account.actor.id },
          },
          blockers: {
            where: ctx.state.account == null
              ? { RAW: sql`false` }
              : { blockerId: ctx.state.account.actor.id },
          },
        },
      },
      mentions: true,
      media: {
        orderBy: { index: "asc" },
      },
    },
  });
  if (post == null) return ctx.next();
  if (!isPostVisibleTo(post, ctx.state.account?.actor)) return ctx.next();
  const medium = post.media[index];
  if (medium == null) return ctx.next();
  const disk = drive.use();
  return new Response(
    JSON.stringify({
      ...medium,
      thumbnailUrl: medium.thumbnailKey == null
        ? null
        : await disk.getUrl(medium.thumbnailKey),
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
});
