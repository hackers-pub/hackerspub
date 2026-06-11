import type { Database } from "./db.ts";
import type { Actor } from "./schema.ts";
import type { Uuid } from "./uuid.ts";

/**
 * Thrown by write-path guards when a suspended actor attempts an action
 * that suspension forbids (creating posts, replying, reacting, boosting,
 * following, or voting).
 */
export class ActorSuspendedError extends Error {
  readonly actorId: Uuid;
  /** `null` for a permanent suspension (ban). */
  readonly suspendedUntil: Date | null;

  constructor(actor: Pick<Actor, "id" | "suspendedUntil">) {
    super(
      actor.suspendedUntil == null
        ? "The actor is permanently suspended."
        : `The actor is suspended until ${actor.suspendedUntil.toISOString()}.`,
    );
    this.name = "ActorSuspendedError";
    this.actorId = actor.id;
    this.suspendedUntil = actor.suspendedUntil;
  }
}

/**
 * Whether the actor is under an *active* suspension (temporary or
 * permanent) at the given instant.  Activeness is a pure time comparison;
 * expired suspensions need no cleanup writes (lazy expiry).
 */
export function isActorSuspended(
  actor: Pick<Actor, "suspended" | "suspendedUntil">,
  now: Date = new Date(),
): boolean {
  return actor.suspended != null && actor.suspended <= now &&
    (actor.suspendedUntil == null || actor.suspendedUntil > now);
}

/**
 * Whether the actor is under an active *permanent* suspension.  For local
 * accounts this means the account cannot log in at all; for remote actors
 * it is a permanent federation block.
 */
export function isActorBanned(
  actor: Pick<Actor, "suspended" | "suspendedUntil">,
  now: Date = new Date(),
): boolean {
  return isActorSuspended(actor, now) && actor.suspendedUntil == null;
}

/**
 * Throws {@link ActorSuspendedError} when the actor is under an active
 * suspension.  Call this at the top of write paths (post creation,
 * reactions, follows, boosts, votes).
 */
export function assertActorNotSuspended(
  actor: Pick<Actor, "id" | "suspended" | "suspendedUntil">,
  now: Date = new Date(),
): void {
  if (isActorSuspended(actor, now)) {
    throw new ActorSuspendedError(actor);
  }
}

/**
 * Like {@link assertActorNotSuspended}, but looks the actor up by the
 * owning account id; for write paths that have an `accountId` but no
 * hydrated actor row.  Unknown accounts pass (the caller fails on them
 * separately).
 */
export async function assertAccountActorNotSuspended(
  db: Database,
  accountId: Uuid,
  now: Date = new Date(),
): Promise<void> {
  const actor = await db.query.actorTable.findFirst({
    where: { accountId },
    columns: { id: true, suspended: true, suspendedUntil: true },
  });
  if (actor != null) assertActorNotSuspended(actor, now);
}
