import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, eq, inArray } from "drizzle-orm";
import { syncActorFromAccount, toRecipient } from "../actor.ts";
import type { ApplicationContext } from "../context.ts";
import type { Database } from "../db.ts";
import { assertAccountActorNotSuspended } from "../moderation.ts";
import { refreshNewsScores } from "../news.ts";
import {
  createShareNotification,
  deleteShareNotification,
} from "../notification.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type Medium,
  type Post,
  postTable,
  type PostVisibility,
} from "../schema.ts";
import { addPostToTimeline, removeFromTimeline } from "../timeline.ts";
import { generateUuidV7, type Uuid } from "../uuid.ts";
import { updateSharesCount } from "./engagement.ts";
import { transactional } from "../tx.ts";

const logger = getLogger(["hackerspub", "models", "post", "sharing"]);

async function getOriginalSharedPost(
  db: Database,
  post: Post & { actor: Actor },
): Promise<Post & { actor: Actor }> {
  if (post.sharedPostId == null) return post;

  const visited = new Set<Uuid>([post.id]);
  let currentId: Uuid | null = post.sharedPostId;
  while (currentId != null) {
    if (visited.has(currentId)) return post;
    visited.add(currentId);

    const current: Pick<Post, "id" | "sharedPostId"> | undefined = await db
      .query.postTable.findFirst({
        columns: { id: true, sharedPostId: true },
        where: { id: currentId },
      });
    if (current == null) return post;
    if (current.sharedPostId == null) {
      const original = await db.query.postTable.findFirst({
        with: { actor: true },
        where: { id: current.id },
      });
      return original ?? post;
    }
    currentId = current.sharedPostId;
  }

  return post;
}

async function sharePostOperation(
  fedCtx: ApplicationContext,
  account: Account & {
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  },
  post: Post & { actor: Actor },
  visibility?: PostVisibility,
): Promise<Post> {
  const { db } = fedCtx;
  await assertAccountActorNotSuspended(db, account.id);
  const sharedPost = await getOriginalSharedPost(db, post);
  // Callers reject censored targets with a proper response; this is a
  // backstop so no future caller can boost (and thus re-amplify and
  // copy into the wrapper) moderation-hidden content.
  if (post.censored != null || sharedPost.censored != null) {
    throw new TypeError("A censored post cannot be shared.");
  }
  const actor = await syncActorFromAccount(fedCtx, account);
  const id = generateUuidV7();
  const posts = await db.insert(postTable).values({
    id,
    iri: fedCtx.getObjectUri(vocab.Announce, { id }).href,
    type: sharedPost.type,
    visibility: visibility || account.shareVisibility,
    actorId: actor.id,
    sharedPostId: sharedPost.id,
    name: sharedPost.name,
    contentHtml: sharedPost.contentHtml,
    language: sharedPost.language,
    tags: {},
    emojis: sharedPost.emojis,
    sensitive: sharedPost.sensitive,
    url: sharedPost.url,
  }).onConflictDoNothing().returning();
  if (posts.length < 1) {
    const share = await db.query.postTable.findFirst({
      where: {
        actorId: actor.id,
        sharedPostId: sharedPost.id,
      },
    });
    return share!;
  }
  const share = posts[0];
  sharedPost.sharesCount = await updateSharesCount(db, sharedPost, 1);
  share.sharesCount = sharedPost.sharesCount;
  await refreshNewsScores(db, [
    sharedPost.type === "Article" ? sharedPost.linkId : null,
  ]);
  await addPostToTimeline(db, share);

  // Create a share notification for the original post's author
  if (sharedPost.actor.accountId != null) {
    const notification = await createShareNotification(
      db,
      sharedPost.actor.accountId,
      sharedPost,
      actor,
      share.published,
    );
    logger.debug("Created share notification for {accountId}: {notification}", {
      accountId: sharedPost.actor.accountId,
      notification,
    });
  }
  const announce = fedCtx.services.federation.getAnnounce(fedCtx, {
    ...share,
    sharedPost,
    actor: { ...actor, account },
    mentions: [],
  });
  await fedCtx.sendActivity(
    { identifier: account.id },
    "followers",
    announce,
    {
      orderingKey: share.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  await fedCtx.sendActivity(
    { identifier: account.id },
    toRecipient(sharedPost.actor),
    announce,
    {
      orderingKey: share.iri,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  return share;
}

export const sharePost = transactional(sharePostOperation);

async function unsharePostOperation(
  fedCtx: ApplicationContext,
  account: Account & {
    avatarMedium: Medium | null;
    emails: AccountEmail[];
    links: AccountLink[];
  },
  sharedPost: Post & { actor: Actor },
): Promise<Post | undefined> {
  const { db } = fedCtx;
  const originalPost = await getOriginalSharedPost(db, sharedPost);
  if (originalPost.sharedPostId != null) return;
  const actor = await syncActorFromAccount(fedCtx, account);
  const unshared = await db.delete(postTable).where(
    and(
      eq(postTable.actorId, actor.id),
      eq(postTable.sharedPostId, originalPost.id),
    ),
  ).returning();
  if (unshared.length < 1) return undefined;
  originalPost.sharesCount = await updateSharesCount(db, originalPost, -1);
  await refreshNewsScores(db, [
    originalPost.type === "Article" ? originalPost.linkId : null,
  ]);
  await removeFromTimeline(db, unshared[0]);
  if (originalPost.actor.accountId != null) {
    await deleteShareNotification(
      db,
      originalPost.actor.accountId,
      originalPost,
      actor,
    );
  }
  const announce = fedCtx.services.federation.getAnnounce(fedCtx, {
    ...unshared[0],
    actor: { ...actor, account },
    sharedPost: originalPost,
    mentions: [],
  });
  const undo = new vocab.Undo({
    actor: fedCtx.getActorUri(account.id),
    object: announce,
    tos: announce.toIds,
    ccs: announce.ccIds,
  });
  await fedCtx.sendActivity(
    { identifier: account.id },
    "followers",
    undo,
    {
      orderingKey: unshared[0].iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  await fedCtx.sendActivity(
    { identifier: account.id },
    toRecipient(originalPost.actor),
    undo,
    {
      orderingKey: unshared[0].iri,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  return unshared[0];
}

export const unsharePost = transactional(unsharePostOperation);

export async function arePostsSharedBy(
  db: Database,
  postIds: readonly Uuid[],
  account: Account & { actor: Actor },
): Promise<Set<Uuid>> {
  if (postIds.length < 1) return new Set();
  const rows = await db.select({ sharedPostId: postTable.sharedPostId })
    .from(postTable)
    .where(
      and(
        eq(postTable.actorId, account.actor.id),
        inArray(postTable.sharedPostId, postIds as Uuid[]),
      ),
    );
  const result = new Set<Uuid>();
  for (const row of rows) {
    if (row.sharedPostId != null) result.add(row.sharedPostId);
  }
  return result;
}
