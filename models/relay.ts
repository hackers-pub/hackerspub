import type { Context } from "@fedify/fedify";
import { Follow, Undo } from "@fedify/vocab";
import { and, eq, isNull, sql } from "drizzle-orm";
import { toRecipient } from "./actor.ts";
import type { ContextData } from "./context.ts";
import type { Database } from "./db.ts";
import {
  type Actor,
  type Instance,
  type RelaySubscription,
  relaySubscriptionTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

/**
 * A relay subscription together with the relay `Actor` it points at (and that
 * actor's `Instance`).  This is the shape the admin UI and the federation
 * inbox handlers consume.
 */
export type RelaySubscriptionWithActor = RelaySubscription & {
  actor: Actor & { instance: Instance };
};

/**
 * The identifier the instance actor is addressed by in Fedify: the canonical
 * origin's hostname (e.g. `hackers.pub`).  The instance actor has no `Account`
 * or `actorTable` row; it is dispatched purely from this identifier.
 */
function getInstanceActorIdentifier(fedCtx: Context<ContextData>): string {
  return new URL(fedCtx.canonicalOrigin).hostname;
}

/**
 * Builds the stable `Follow` activity IRI used for a relay subscription.  The
 * subscription row's UUID is embedded so the relay can echo it back inside its
 * `Accept`/`Reject`, letting us reconcile the response to the exact row.
 */
export function getRelayFollowIri(
  fedCtx: Context<ContextData>,
  subscriptionId: Uuid,
): URL {
  const identifier = getInstanceActorIdentifier(fedCtx);
  return new URL(
    `#relay-follow/${subscriptionId}`,
    fedCtx.getActorUri(identifier),
  );
}

/** Lists every relay this instance is subscribed to, newest first. */
export function getRelaySubscriptions(
  db: Database,
): Promise<RelaySubscriptionWithActor[]> {
  return db.query.relaySubscriptionTable.findMany({
    with: { actor: { with: { instance: true } } },
    orderBy: { created: "desc" },
  });
}

/** Fetches a single relay subscription (with its relay actor) by row UUID. */
export function getRelaySubscription(
  db: Database,
  id: Uuid,
): Promise<RelaySubscriptionWithActor | undefined> {
  return db.query.relaySubscriptionTable.findFirst({
    with: { actor: { with: { instance: true } } },
    where: { id },
  });
}

/**
 * Subscribes the instance actor to a relay by sending it a `Follow` whose
 * `object` is the relay actor itself (the LitePub/Pleroma relay convention),
 * and records a pending subscription row.  When the relay is already
 * subscribed: a still-pending subscription re-sends the stored `Follow` (so a
 * `Follow` that never reached the relay can be retried) and returns the
 * existing row, while an already-accepted subscription is a no-op that returns
 * `undefined`.
 */
export async function subscribeRelay(
  fedCtx: Context<ContextData>,
  relayActor: Actor,
): Promise<RelaySubscription | undefined> {
  const { db } = fedCtx.data;
  const id = generateUuidV7();
  const followIri = getRelayFollowIri(fedCtx, id);
  const rows = await db.insert(relaySubscriptionTable).values({
    id,
    actorId: relayActor.id,
    followIri: followIri.href,
  }).onConflictDoNothing({ target: relaySubscriptionTable.actorId })
    .returning();
  let subscription = rows[0];
  if (subscription == null) {
    // Already subscribed.  Re-send the `Follow` only while the relay has not
    // yet accepted, so a subscription whose `Follow` never reached the relay
    // (e.g. the send failed) can be retried instead of staying pending
    // forever.  An already-accepted relay is a no-op.
    const existing = await db.query.relaySubscriptionTable.findFirst({
      where: { actorId: relayActor.id },
    });
    if (existing == null || existing.accepted != null) return undefined;
    subscription = existing;
  }
  const identifier = getInstanceActorIdentifier(fedCtx);
  await fedCtx.sendActivity(
    { identifier },
    toRecipient(relayActor),
    new Follow({
      id: new URL(subscription.followIri),
      actor: fedCtx.getActorUri(identifier),
      object: new URL(relayActor.iri),
    }),
    {
      orderingKey: subscription.followIri,
      excludeBaseUris: [
        new URL(fedCtx.canonicalOrigin),
        new URL(fedCtx.origin),
      ],
      preferSharedInbox: false,
    },
  );
  return subscription;
}

/**
 * Unsubscribes the instance actor from a relay by sending an `Undo` of the
 * original `Follow` and then deleting the subscription row.  The `Undo` is
 * queued *before* the row is deleted: GraphQL mutations here run in autocommit
 * (no rolling-back transaction), so deleting first would drop the local record
 * even if the send failed, leaving the relay forwarding with nothing left to
 * retry from.  Returns the deleted row, or `undefined` when the subscription
 * was already gone.
 */
export async function unsubscribeRelay(
  fedCtx: Context<ContextData>,
  subscription: RelaySubscription & { actor: Actor },
): Promise<RelaySubscription | undefined> {
  const { db } = fedCtx.data;
  const identifier = getInstanceActorIdentifier(fedCtx);
  const followIri = new URL(subscription.followIri);
  await fedCtx.sendActivity(
    { identifier },
    toRecipient(subscription.actor),
    new Undo({
      id: new URL(
        `#relay-unfollow/${subscription.id}`,
        fedCtx.getActorUri(identifier),
      ),
      actor: fedCtx.getActorUri(identifier),
      object: new Follow({
        id: followIri,
        actor: fedCtx.getActorUri(identifier),
        object: new URL(subscription.actor.iri),
      }),
    }),
    {
      orderingKey: followIri.href,
      excludeBaseUris: [
        new URL(fedCtx.canonicalOrigin),
        new URL(fedCtx.origin),
      ],
      preferSharedInbox: false,
    },
  );
  const rows = await db.delete(relaySubscriptionTable)
    .where(eq(relaySubscriptionTable.id, subscription.id))
    .returning();
  if (rows.length < 1) return undefined;
  return rows[0];
}

/**
 * Marks a pending relay subscription as accepted, in response to the relay's
 * `Accept`.  Matches by the `Follow` IRI and verifies the accepting actor is
 * the relay the subscription points at, so a forged `Accept` from an unrelated
 * actor cannot accept it.  Returns the matched subscription (idempotent if it
 * was already accepted), or `undefined` when nothing matched.
 */
export async function markRelaySubscriptionAccepted(
  db: Database,
  followIri: string,
  relayActorIri: string,
): Promise<RelaySubscription | undefined> {
  const subscription = await db.query.relaySubscriptionTable.findFirst({
    with: { actor: { columns: { iri: true } } },
    where: { followIri },
  });
  if (subscription == null || subscription.actor.iri !== relayActorIri) {
    return undefined;
  }
  // Conditional update on a still-pending row, so a concurrent duplicate
  // `Accept` cannot overwrite the original acceptance timestamp.
  const rows = await db.update(relaySubscriptionTable).set({
    accepted: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(relaySubscriptionTable.id, subscription.id),
    isNull(relaySubscriptionTable.accepted),
  )).returning();
  if (rows.length > 0) return rows[0];
  // Nothing flipped: the row was already accepted, or was deleted between the
  // read and the update.  Re-read to return the current truth (`undefined` if
  // it is gone) rather than the stale pending object.
  return await db.query.relaySubscriptionTable.findFirst({
    where: { id: subscription.id },
  });
}

/**
 * Removes a relay subscription in response to the relay's `Reject` (or `Undo`).
 * Matches by the `Follow` IRI and verifies the rejecting actor is the relay the
 * subscription points at.  Returns the deleted row, or `undefined` when nothing
 * matched.
 */
export async function removeRelaySubscription(
  db: Database,
  followIri: string,
  relayActorIri: string,
): Promise<RelaySubscription | undefined> {
  const subscription = await db.query.relaySubscriptionTable.findFirst({
    with: { actor: { columns: { iri: true } } },
    where: { followIri },
  });
  if (subscription == null || subscription.actor.iri !== relayActorIri) {
    return undefined;
  }
  const rows = await db.delete(relaySubscriptionTable)
    .where(eq(relaySubscriptionTable.id, subscription.id))
    .returning();
  return rows[0];
}
