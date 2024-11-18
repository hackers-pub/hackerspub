import { Accept, Follow, InboxContext } from "@fedify/fedify";
import { eq } from "drizzle-orm";
import { db } from "../../db.ts";
import { validateUuid } from "../../models/uuid.ts";
import { accountTable, actorTable } from "../../models/schema.ts";
import { acceptFollowing } from "../../models/following.ts";

export async function onFollowAccepted(
  fedCtx: InboxContext<void>,
  accept: Accept,
): Promise<void> {
  const follow = await accept.getObject();
  if (!(follow instanceof Follow)) return;
  else if (follow.objectId == null) return;
  else if (accept.actorId?.href !== follow.objectId.href) return;
  const followActor = fedCtx.parseUri(follow.actorId);
  if (followActor?.type !== "actor") return;
  else if (!validateUuid(followActor.identifier)) return;
  const follower = await db.query.accountTable.findFirst({
    with: { actor: true },
    where: eq(accountTable.id, followActor.identifier),
  });
  if (follower == null) return;
  const followee = await db.query.actorTable.findFirst({
    where: eq(actorTable.iri, follow.objectId.href),
  });
  if (followee == null) return;
  if (follow.id == null) await acceptFollowing(db, follower, followee);
  else await acceptFollowing(db, follow.id);
}
