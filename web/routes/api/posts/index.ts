import {
  canActorRequestQuotePost,
  getOriginalPostId,
  isPostObject,
  isPostVisibleTo,
  persistPost,
} from "@hackerspub/models/post";
import { sql } from "drizzle-orm";
import { db } from "../../../db.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const iri = ctx.url.searchParams.get("iri");
  if (iri === null || !URL.canParse(iri) || !iri.match(/^https?:/)) {
    return ctx.next();
  }
  const { account, fedCtx } = ctx.state;
  let requestedPost = await db.query.postTable.findFirst({
    where: { OR: [{ iri }, { url: iri }] },
  });
  if (requestedPost == null) {
    const documentLoader = account == null
      ? undefined
      : await fedCtx.getDocumentLoader({ identifier: account.id });
    const object = await fedCtx.lookupObject(iri, { documentLoader });
    if (!isPostObject(object)) return ctx.next();
    const persistedPost = await persistPost(fedCtx, object, { documentLoader });
    if (persistedPost == null) return ctx.next();
    requestedPost = persistedPost;
  }
  const postId = await getOriginalPostId(db, requestedPost);
  if (postId == null) return ctx.next();
  const post = await db.query.postTable.findFirst({
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
      mentions: { with: { actor: true } },
    },
    where: { id: postId },
  });
  if (post == null) return ctx.next();
  if (!isPostVisibleTo(post, account?.actor)) return ctx.next();
  const viewerCanQuote = account != null &&
    canActorRequestQuotePost(post, account.actor);
  return new Response(JSON.stringify({ ...post, viewerCanQuote }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
});
