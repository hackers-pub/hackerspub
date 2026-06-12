import {
  canActorRequestQuotePost,
  getOriginalPostId,
  isPostObject,
  isPostVisibleTo,
  persistPost,
} from "@hackerspub/models/post";
import { sql } from "drizzle-orm";
import { isPostCensoredFor } from "../../../censorship.ts";
import { db } from "../../../db.ts";
import { define } from "../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const iri = ctx.url.searchParams.get("iri");
  if (iri === null || !URL.canParse(iri) || !iri.match(/^https?:/)) {
    return ctx.next();
  }
  const { account, fedCtx } = ctx.state;
  // Share wrappers copy the boosted post's `url`, so matching by URL must
  // skip them: otherwise a pasted original-post URL could resolve to a
  // wrapper row (e.g. a censored one) instead of the original post.
  let requestedPost = await db.query.postTable.findFirst({
    where: {
      OR: [
        { iri },
        { AND: [{ url: iri }, { sharedPostId: { isNull: true } }] },
      ],
    },
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
  // A censored post (or share wrapper) cannot be looked up for quoting.
  if (isPostCensoredFor(requestedPost, account)) return ctx.next();
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
  // A censored post cannot be looked up for quoting; behaving as
  // not-found keeps its content out of the composer preview.
  if (isPostCensoredFor(post, account)) return ctx.next();
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
