import type { Context, DocumentLoader } from "@fedify/fedify";
import { isActor } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { and, eq } from "drizzle-orm";
import { getPersistedActor, persistActor, toRecipient } from "./actor.ts";
import type { ContextData } from "./context.ts";
import { removeFollower, unfollow } from "./following.ts";
import {
  type Account,
  type Actor,
  type Blocking,
  blockingTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";

export async function persistBlocking(
  fedCtx: Context<ContextData>,
  block: vocab.Block,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<Blocking | undefined> {
  if (block.id == null || block.actorId == null || block.objectId == null) {
    return undefined;
  }
  const getterOpts = { ...options, suppressError: true };
  const { db } = fedCtx.data;
  let blocker = await getPersistedActor(db, block.actorId);
  if (blocker == null) {
    const actor = await block.getActor(getterOpts);
    if (actor == null) return undefined;
    blocker = await persistActor(fedCtx, actor, options);
    if (blocker == null) return undefined;
  }
  let blockee = await getPersistedActor(db, block.objectId);
  if (blockee == null) {
    const object = await block.getObject(getterOpts);
    if (!isActor(object)) return undefined;
    blockee = await persistActor(fedCtx, object, options);
    if (blockee == null) return undefined;
  }
  const rows = await db.insert(blockingTable)
    .values({
      id: generateUuidV7(),
      iri: block.id.href,
      blockerId: blocker.id,
      blockeeId: blockee.id,
    })
    .onConflictDoNothing()
    .returning();
  if (rows.length < 1) return undefined;
  if (blockee.account == null) return undefined;
  await removeFollower(
    fedCtx,
    { ...blockee.account, actor: blockee },
    blocker,
  );
  await unfollow(
    fedCtx,
    { ...blockee.account, actor: blockee },
    blocker,
  );
  return rows[0];
}

export async function block(
  fedCtx: Context<ContextData>,
  blocker: Account & { actor: Actor },
  blockee: Actor,
): Promise<Blocking | undefined> {
  const id = generateUuidV7();
  const { db } = fedCtx.data;
  const rows = await db.insert(blockingTable)
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
        excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
        fanout: "skip",
        preferSharedInbox: false,
      },
    );
  }
  return rows[0];
}

export async function unblock(
  fedCtx: Context<ContextData>,
  blocker: Account & { actor: Actor },
  blockee: Actor,
): Promise<Blocking | undefined> {
  const { db } = fedCtx.data;
  const rows = await db.delete(blockingTable).where(
    and(
      eq(blockingTable.blockerId, blocker.actor.id),
      eq(blockingTable.blockeeId, blockee.id),
    ),
  ).returning();
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
      { excludeBaseUris: [new URL(fedCtx.canonicalOrigin)] },
    );
  }
  return rows[0];
}
