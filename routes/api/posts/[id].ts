import { eq } from "drizzle-orm";
import { db } from "../../../db.ts";
import { isPostVisibleTo } from "../../../models/post.ts";
import { postTable } from "../../../models/schema.ts";
import { validateUuid } from "../../../models/uuid.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const postId = ctx.params.id;
  if (!validateUuid(postId)) return ctx.next();
  const { account } = ctx.state;
  const post = await db.query.postTable.findFirst({
    with: {
      actor: { with: { followers: true } },
      articleSource: true,
      mentions: { with: { actor: true } },
    },
    where: eq(postTable.id, postId),
  });
  if (post == null) return ctx.next();
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
