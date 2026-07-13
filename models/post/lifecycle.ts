import { PUBLIC_COLLECTION, type Recipient } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { eq, inArray, or } from "drizzle-orm";
import type { ApplicationContext } from "../context.ts";
import { refreshNewsScores } from "../news.ts";
import {
  type Actor,
  articleSourceTable,
  noteSourceTable,
  type Post,
  postTable,
} from "../schema.ts";
import type { Uuid } from "../uuid.ts";
import {
  updateQuotesCount,
  updateRepliesCount,
  updateSharesCount,
} from "./engagement.ts";

export async function deletePost(
  fedCtx: ApplicationContext,
  post: Post & { actor: Actor; replyTarget: Post | null },
): Promise<void> {
  const { db } = fedCtx;
  const replies = await db.query.postTable.findMany({
    with: { actor: true },
    where: {
      replyTargetId: post.id,
      OR: [
        { articleSourceId: { isNotNull: true } },
        { noteSourceId: { isNotNull: true } },
      ],
    },
  });
  for (const reply of replies) {
    await deletePost(fedCtx, { ...reply, replyTarget: post });
  }
  // Get posts quoting this post before deleting
  const quotingPosts = await db.query.postTable.findMany({
    where: {
      quotedPostId: post.id,
    },
  });

  const interactions = await db.delete(postTable).where(
    or(
      eq(postTable.replyTargetId, post.id),
      eq(postTable.sharedPostId, post.id),
      eq(postTable.quotedPostId, post.id),
      eq(postTable.id, post.id),
    ),
  ).returning();

  const originalPostIds = [
    post.replyTargetId,
    post.sharedPostId,
    post.quotedPostId,
  ].filter((id): id is Uuid => id != null);
  const originalPosts = originalPostIds.length < 1
    ? []
    : await db.query.postTable.findMany({
      where: {
        OR: originalPostIds.map((id) => ({ id })),
      },
    });

  if (post.replyTargetId != null) {
    const replyTarget = originalPosts.find((p) => p.id === post.replyTargetId);
    if (replyTarget != null) {
      await updateRepliesCount(db, replyTarget, -1);
    }
  }
  if (post.sharedPostId != null) {
    const sharedPost = originalPosts.find((p) => p.id === post.sharedPostId);
    if (sharedPost != null) {
      await updateSharesCount(db, sharedPost, -1);
    }
  }
  if (post.quotedPostId != null) {
    const quotedPost = originalPosts.find((p) => p.id === post.quotedPostId);
    if (quotedPost != null) {
      await updateQuotesCount(db, quotedPost, -1);
    }
  }

  // When a quoted post is deleted, update the quotes count of the original posts
  for (const quotingPost of quotingPosts) {
    if (quotingPost.quotedPostId) {
      const quotedPost = await db.query.postTable.findFirst({
        where: {
          id: quotingPost.quotedPostId,
        },
      });
      if (quotedPost) {
        await updateQuotesCount(db, quotedPost, -1);
      }
    }
  }
  // Re-score every link affected by this cascade: the link each deleted post
  // shared (this post plus its bulk-deleted replies/quotes/boosts, any of which
  // may itself be a sharing post), and the links of the posts this post replied
  // to / quoted (whose public reply/quote count dropped).
  const affectedLinkIds = new Set<Uuid>();
  const parentIds = new Set<Uuid>();
  for (const deleted of interactions) {
    if (deleted.linkId != null) affectedLinkIds.add(deleted.linkId);
    // A bulk-deleted interaction may reply to or quote a story other than this
    // post (e.g. a post that quoted this one while also replying to a different
    // story); that story's public reply/quote count just dropped too.
    if (deleted.replyTargetId != null) parentIds.add(deleted.replyTargetId);
    if (deleted.quotedPostId != null) parentIds.add(deleted.quotedPostId);
  }
  for (const original of originalPosts) {
    if (original.linkId != null) affectedLinkIds.add(original.linkId);
  }
  if (parentIds.size > 0) {
    const parents = await db.query.postTable.findMany({
      where: { id: { in: [...parentIds] } },
      columns: { linkId: true },
    });
    for (const parent of parents) {
      if (parent.linkId != null) affectedLinkIds.add(parent.linkId);
    }
  }
  await refreshNewsScores(db, [...affectedLinkIds]);
  const noteSourceIds = interactions
    .filter((i) => i.noteSourceId != null)
    .map((i) => i.noteSourceId!);
  if (noteSourceIds.length > 0) {
    await db.delete(noteSourceTable).where(
      inArray(noteSourceTable.id, noteSourceIds),
    );
  }
  const articleSourceIds = interactions
    .filter((i) => i.articleSourceId != null)
    .map((i) => i.articleSourceId!);
  if (articleSourceIds.length > 0) {
    await db.delete(articleSourceTable).where(
      inArray(articleSourceTable.id, articleSourceIds),
    );
  }
  if (post.actor.accountId == null) return;
  const interactors = await db.query.actorTable.findMany({
    where: {
      id: { in: [...interactions, ...originalPosts].map((i) => i.actorId) },
    },
  });
  const recipients: Recipient[] = interactors.map((actor) => ({
    id: new URL(actor.iri),
    inboxId: new URL(actor.inboxUrl),
    endpoints: actor.sharedInboxUrl == null ? null : {
      sharedInbox: new URL(actor.sharedInboxUrl),
    },
  }));
  const activity = new vocab.Delete({
    id: new URL("#delete", post.iri),
    actor: fedCtx.getActorUri(post.actor.accountId),
    to: PUBLIC_COLLECTION,
    cc: fedCtx.getFollowersUri(post.actor.accountId),
    object: new vocab.Tombstone({
      id: new URL(post.iri),
    }),
  });
  await fedCtx.sendActivity(
    { identifier: post.actor.accountId },
    "followers",
    activity,
    {
      orderingKey: post.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  await fedCtx.services.federation.sendTagsPubRelayActivity(
    fedCtx,
    post.actor.accountId,
    activity,
    {
      orderingKey: post.iri,
      visibility: post.visibility,
      accountBio: post.actor.bioHtml,
      relayedTags: post.relayedTags,
    },
  );
  await fedCtx.sendActivity(
    { identifier: post.actor.accountId },
    recipients,
    activity,
    {
      orderingKey: post.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
}
