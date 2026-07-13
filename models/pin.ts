import * as vocab from "@fedify/vocab";
import { and, count, eq, inArray } from "drizzle-orm";
import type { ApplicationContext } from "./context.ts";
import type { Database, Transaction } from "./db.ts";
import {
  type Actor,
  actorTable,
  type Pin,
  pinTable,
  type Post,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export const MAX_PINNED_POSTS = 20;

export function canPinPost(
  actor: Actor,
  post: Post,
): boolean {
  return post.actorId === actor.id &&
    post.sharedPostId == null &&
    (post.visibility === "public" || post.visibility === "unlisted");
}

export async function pinPost(
  fedCtx: ApplicationContext,
  actor: Actor,
  post: Post,
): Promise<Pin | null> {
  const { db } = fedCtx;
  if (!canPinPost(actor, post)) return null;

  const pinInTransaction = async (tx: Transaction) => {
    await tx
      .select({ id: actorTable.id })
      .from(actorTable)
      .where(eq(actorTable.id, actor.id))
      .for("update");

    const existing = await tx.query.pinTable.findFirst({
      where: {
        actorId: actor.id,
        postId: post.id,
      },
    });
    if (existing != null) return { pin: existing, inserted: false };

    const [{ pinnedPosts }] = await tx
      .select({ pinnedPosts: count() })
      .from(pinTable)
      .where(eq(pinTable.actorId, actor.id));
    if (pinnedPosts >= MAX_PINNED_POSTS) {
      return { pin: null, inserted: false };
    }

    const [pin] = await tx
      .insert(pinTable)
      .values({ actorId: actor.id, postId: post.id })
      .onConflictDoNothing()
      .returning();
    if (pin != null) return { pin, inserted: true };

    const existingAfterConflict = await tx.query.pinTable.findFirst({
      where: {
        actorId: actor.id,
        postId: post.id,
      },
    });
    return { pin: existingAfterConflict ?? null, inserted: false };
  };

  const result = isTransaction(db)
    ? await pinInTransaction(db)
    : await db.transaction(pinInTransaction);

  if (result.inserted && result.pin != null) {
    await sendPinActivity(fedCtx, actor, post);
  }
  return result.pin;
}

function isTransaction(db: Database): db is Transaction {
  return "rollback" in db;
}

export async function unpinPost(
  fedCtx: ApplicationContext,
  actor: Actor,
  post: Post,
): Promise<Pin | null> {
  const { db } = fedCtx;
  const [pin] = await db
    .delete(pinTable)
    .where(
      and(
        eq(pinTable.actorId, actor.id),
        eq(pinTable.postId, post.id),
      ),
    )
    .returning();
  if (pin != null) await sendUnpinActivity(fedCtx, actor, post);
  return pin ?? null;
}

async function sendPinActivity(
  fedCtx: ApplicationContext,
  actor: Actor,
  post: Post,
): Promise<void> {
  if (actor.accountId == null) return;
  const activity = new vocab.Add({
    id: new URL(
      `#add/${crypto.randomUUID()}`,
      fedCtx.getActorUri(actor.accountId),
    ),
    actor: fedCtx.getActorUri(actor.accountId),
    object: new URL(post.iri),
    target: fedCtx.getFeaturedUri(actor.accountId),
    to: fedCtx.getFollowersUri(actor.accountId),
  });
  await fedCtx.sendActivity(
    { identifier: actor.accountId },
    "followers",
    activity,
    {
      orderingKey: post.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
}

async function sendUnpinActivity(
  fedCtx: ApplicationContext,
  actor: Actor,
  post: Post,
): Promise<void> {
  if (actor.accountId == null) return;
  const activity = new vocab.Remove({
    id: new URL(
      `#remove/${crypto.randomUUID()}`,
      fedCtx.getActorUri(actor.accountId),
    ),
    actor: fedCtx.getActorUri(actor.accountId),
    object: new URL(post.iri),
    target: fedCtx.getFeaturedUri(actor.accountId),
    to: fedCtx.getFollowersUri(actor.accountId),
  });
  await fedCtx.sendActivity(
    { identifier: actor.accountId },
    "followers",
    activity,
    {
      orderingKey: post.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
}

export async function isPostPinnedBy(
  db: Database,
  post: Post,
  actor?: Actor | null,
): Promise<boolean> {
  if (actor == null) return false;
  const rows = await db
    .select({ postId: pinTable.postId })
    .from(pinTable)
    .where(
      and(
        eq(pinTable.actorId, actor.id),
        eq(pinTable.postId, post.id),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function arePostsPinnedBy(
  db: Database,
  postIds: readonly Uuid[],
  actor: Actor,
): Promise<Set<Uuid>> {
  if (postIds.length < 1) return new Set();
  const rows = await db
    .select({ postId: pinTable.postId })
    .from(pinTable)
    .where(
      and(
        eq(pinTable.actorId, actor.id),
        inArray(pinTable.postId, postIds as Uuid[]),
      ),
    );
  return new Set(rows.map((row) => row.postId));
}
