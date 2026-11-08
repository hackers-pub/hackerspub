import type { RequestContext } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Database } from "@hackerspub/models/db";
import { isPostVisibleTo } from "@hackerspub/models/post/visibility";
import type { Actor, Post } from "@hackerspub/models/schema";

/** Evaluate visibility using only the verified requester's relationships. */
export async function isPostVisibleToRequester(
  db: Database,
  post: Post & { actor: Actor },
  requesterIri?: string,
): Promise<boolean> {
  const requester =
    requesterIri == null
      ? undefined
      : await db.query.actorTable.findFirst({
          where: { iri: requesterIri },
          with: {
            followees: { where: { followeeId: post.actor.id } },
            blockers: { where: { blockerId: post.actor.id } },
            blockees: { where: { blockeeId: post.actor.id } },
            mentions: { where: { postId: post.id } },
          },
        });
  if (requester == null) {
    return isPostVisibleTo(
      {
        ...post,
        actor: { ...post.actor, followers: [], blockees: [], blockers: [] },
        mentions: [],
      },
      requesterIri == null ? undefined : { iri: requesterIri },
    );
  }
  return isPostVisibleTo(
    {
      ...post,
      actor: {
        ...post.actor,
        followers: requester.followees,
        // From the requester's side, the author's block directions reverse.
        blockees: requester.blockers,
        blockers: requester.blockees,
      },
      mentions: requester.mentions,
    },
    requester,
  );
}

/** Keep signature verification ahead of the requester-specific DB lookup. */
export async function authorizePostFetch(
  ctx: RequestContext<ContextData>,
  post: Post & { actor: Actor },
  identifier: string,
): Promise<boolean> {
  const documentLoader = await ctx.getDocumentLoader({ identifier });
  const signedKeyOwner = await ctx.getSignedKeyOwner({ documentLoader });
  return await isPostVisibleToRequester(
    ctx.data.db,
    post,
    signedKeyOwner?.id?.href,
  );
}
