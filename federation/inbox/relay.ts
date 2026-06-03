import type { InboxContext } from "@fedify/fedify";
import type { Accept, Reject } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import {
  markRelaySubscriptionAccepted,
  removeRelaySubscription,
} from "@hackerspub/models/relay";

/**
 * Handles a relay's `Accept` of our instance actor's relay `Follow`.  Matches
 * the subscription by the echoed `Follow` IRI and verifies the accepting actor
 * is the subscribed relay (`markRelaySubscriptionAccepted` enforces both), so a
 * forged `Accept` from an unrelated actor is ignored.  Returns `true` when the
 * `Accept` belonged to a relay subscription (so the inbox dispatcher should
 * stop), or `false` to let the regular follow-acceptance handler run.
 */
export async function onRelayFollowAccepted(
  fedCtx: InboxContext<ContextData>,
  accept: Accept,
): Promise<boolean> {
  const followIri = accept.objectId?.href;
  if (followIri == null || accept.actorId == null) return false;
  const result = await markRelaySubscriptionAccepted(
    fedCtx.data.db,
    followIri,
    accept.actorId.href,
  );
  return result != null;
}

/**
 * Handles a relay's `Reject` of our relay `Follow` (the relay declining or
 * later dropping us).  Matches and verifies the responding actor the same way
 * as `onRelayFollowAccepted`, then removes the subscription.  Returns `true`
 * when the `Reject` belonged to a relay subscription, or `false` to fall
 * through to the regular follow-rejection handler.
 */
export async function onRelayFollowRejected(
  fedCtx: InboxContext<ContextData>,
  reject: Reject,
): Promise<boolean> {
  const followIri = reject.objectId?.href;
  if (followIri == null || reject.actorId == null) return false;
  const result = await removeRelaySubscription(
    fedCtx.data.db,
    followIri,
    reject.actorId.href,
  );
  return result != null;
}
