import { type Context, type DocumentLoader, isActor } from "@fedify/fedify";
import type * as vocab from "@fedify/fedify/vocab";
import type { Database } from "../db.ts";
import { getPersistedActor, persistActor } from "./actor.ts";
import { removeFollower, unfollow } from "./following.ts";
import { type Blocking, blockingTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";

export async function persistBlocking(
  db: Database,
  fedCtx: Context<void>,
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
  let blocker = await getPersistedActor(db, block.actorId);
  if (blocker == null) {
    const actor = await block.getActor(getterOpts);
    if (actor == null) return undefined;
    blocker = await persistActor(db, fedCtx, actor, options);
    if (blocker == null) return undefined;
  }
  let blockee = await getPersistedActor(db, block.objectId);
  if (blockee == null) {
    const object = await block.getObject(getterOpts);
    if (!isActor(object)) return undefined;
    blockee = await persistActor(db, fedCtx, object, options);
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
    db,
    fedCtx,
    { ...blockee.account, actor: blockee },
    blocker,
  );
  await unfollow(
    db,
    fedCtx,
    { ...blockee.account, actor: blockee },
    blocker,
  );
  return rows[0];
}
