import type { DocumentLoader } from "@fedify/fedify";
import { isActor } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { and, eq, inArray } from "drizzle-orm";
import {
  getPersistedActor,
  isFederationBlocked,
  persistActor,
  toRecipient,
} from "./actor.ts";
import type { ApplicationContext } from "./context.ts";
import type { Database } from "./db.ts";
import { removeFollower, unfollow } from "./following.ts";
import {
  type Account,
  type Actor,
  type Blocking,
  blockingTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
import { transactional } from "./tx.ts";

type PersistedBlockingActor = NonNullable<
  Awaited<ReturnType<typeof getPersistedActor>>
>;

export interface PreparedBlocking {
  readonly iri: string;
  readonly blocker: PersistedBlockingActor;
  readonly blockee: PersistedBlockingActor;
}

export async function prepareBlocking(
  fedCtx: ApplicationContext,
  block: vocab.Block,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<PreparedBlocking | undefined> {
  if (block.id == null || block.actorId == null || block.objectId == null) {
    return undefined;
  }
  const getterOpts = { ...options, suppressError: true };
  const { db } = fedCtx;
  let blocker = await getPersistedActor(db, block.actorId);
  if (blocker == null) {
    const actor = await block.getActor(getterOpts);
    if (actor == null) return undefined;
    blocker = await persistActor(fedCtx, actor, options);
    if (blocker == null) return undefined;
  }
  if (isFederationBlocked(blocker)) return undefined;
  let blockee = await getPersistedActor(db, block.objectId);
  if (blockee == null) {
    const object = await block.getObject(getterOpts);
    if (!isActor(object)) return undefined;
    blockee = await persistActor(fedCtx, object, options);
    if (blockee == null) return undefined;
  }
  return { iri: block.id.href, blocker, blockee };
}

export async function persistPreparedBlocking(
  fedCtx: ApplicationContext,
  prepared: PreparedBlocking,
): Promise<Blocking | undefined> {
  const { db } = fedCtx;
  const rows = await db
    .insert(blockingTable)
    .values({
      id: generateUuidV7(),
      iri: prepared.iri,
      blockerId: prepared.blocker.id,
      blockeeId: prepared.blockee.id,
    })
    .onConflictDoNothing()
    .returning();
  if (rows.length < 1) return undefined;
  if (prepared.blockee.account == null) return undefined;
  await removeFollower(
    fedCtx,
    { ...prepared.blockee.account, actor: prepared.blockee },
    prepared.blocker,
  );
  await unfollow(
    fedCtx,
    { ...prepared.blockee.account, actor: prepared.blockee },
    prepared.blocker,
  );
  return rows[0];
}

export async function persistBlocking(
  fedCtx: ApplicationContext,
  block: vocab.Block,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<Blocking | undefined> {
  const prepared = await prepareBlocking(fedCtx, block, options);
  return prepared == null
    ? undefined
    : await persistPreparedBlocking(fedCtx, prepared);
}

async function blockOperation(
  fedCtx: ApplicationContext,
  blocker: Account & { actor: Actor },
  blockee: Actor,
): Promise<Blocking | undefined> {
  const id = generateUuidV7();
  const { db } = fedCtx;
  const removeLocalFollowRelationships = async () => {
    await removeFollower(fedCtx, blocker, blockee);
    await unfollow(fedCtx, blocker, blockee);
  };
  const rows = await db
    .insert(blockingTable)
    .values({
      id,
      iri: new URL(
        `#blocks/${blockee.id}/${id}`,
        fedCtx.getActorUri(blocker.id),
      ).href,
      blockerId: blocker.actor.id,
      blockeeId: blockee.id,
    })
    .onConflictDoNothing()
    .returning();
  await removeLocalFollowRelationships();
  if (rows.length < 1) {
    return await db.query.blockingTable.findFirst({
      where: {
        blockerId: blocker.actor.id,
        blockeeId: blockee.id,
      },
    });
  }
  if (blockee.accountId == null) {
    const block = new vocab.Block({
      id: new URL(rows[0].iri),
      actor: fedCtx.getActorUri(blocker.id),
      object: new URL(blockee.iri),
    });
    await fedCtx.sendActivity(
      { identifier: blocker.id },
      toRecipient(blockee),
      block,
      {
        orderingKey: rows[0].iri,
        excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
        fanout: "skip",
        preferSharedInbox: false,
      },
    );
  }
  return rows[0];
}

export const block = transactional(blockOperation);

async function unblockOperation(
  fedCtx: ApplicationContext,
  blocker: Account & { actor: Actor },
  blockee: Actor,
): Promise<Blocking | undefined> {
  const { db } = fedCtx;
  const rows = await db
    .delete(blockingTable)
    .where(
      and(
        eq(blockingTable.blockerId, blocker.actor.id),
        eq(blockingTable.blockeeId, blockee.id),
      ),
    )
    .returning();
  if (rows.length < 1) return undefined;
  if (blockee.accountId == null) {
    await fedCtx.sendActivity(
      { identifier: blocker.id },
      toRecipient(blockee),
      new vocab.Undo({
        id: new URL(
          `#unblock/${blockee.id}/${rows[0].iri}`,
          fedCtx.getActorUri(blocker.id),
        ),
        actor: fedCtx.getActorUri(blocker.id),
        object: new vocab.Block({
          id: new URL(rows[0].iri),
          actor: fedCtx.getActorUri(blocker.id),
          object: new URL(blockee.iri),
        }),
      }),
      {
        orderingKey: rows[0].iri,
        excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
      },
    );
  }
  return rows[0];
}

export const unblock = transactional(unblockOperation);

export async function getBlockedActorIds(
  db: Database,
  blockerId: Uuid,
  blockeeIds: readonly Uuid[],
): Promise<Set<Uuid>> {
  if (blockeeIds.length < 1) return new Set();
  const rows = await db
    .select({ blockeeId: blockingTable.blockeeId })
    .from(blockingTable)
    .where(
      and(
        eq(blockingTable.blockerId, blockerId),
        inArray(blockingTable.blockeeId, blockeeIds as Uuid[]),
      ),
    );
  return new Set(rows.map((row) => row.blockeeId));
}

export async function getBlockerActorIds(
  db: Database,
  blockeeId: Uuid,
  blockerIds: readonly Uuid[],
): Promise<Set<Uuid>> {
  if (blockerIds.length < 1) return new Set();
  const rows = await db
    .select({ blockerId: blockingTable.blockerId })
    .from(blockingTable)
    .where(
      and(
        eq(blockingTable.blockeeId, blockeeId),
        inArray(blockingTable.blockerId, blockerIds as Uuid[]),
      ),
    );
  return new Set(rows.map((row) => row.blockerId));
}
