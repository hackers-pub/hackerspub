import type { InboxContext } from "@fedify/fedify";
import { type Accept, type Delete, Follow, type Reject } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import type { ContextData } from "@hackerspub/models/context";
import { withInboxTransaction } from "../context.ts";
import { onActorDeleted } from "./actor.ts";
import {
  onFollowAccepted,
  onFollowed,
  onFollowRejected,
  prepareFollower,
} from "./following.ts";
import {
  onQuoteAuthorizationDeleted,
  onQuoteRequestAccepted,
  onQuoteRequestRejected,
} from "./quote.ts";
import { onRelayFollowAccepted, onRelayFollowRejected } from "./relay.ts";
import { onPostDeleted } from "./subscribe.ts";

const logger = getLogger(["hackerspub", "federation", "inbox"]);

export async function onAccepted(
  fedCtx: InboxContext<ContextData>,
  accept: Accept,
): Promise<void> {
  if (accept.resultId == null) {
    const handledByIri = await withInboxTransaction(
      fedCtx,
      async (txCtx) =>
        (await onRelayFollowAccepted(txCtx, accept)) ||
        (await onFollowAccepted(txCtx, accept, { object: undefined })),
    );
    if (handledByIri) return;
    const object = await accept.getObject({
      ...fedCtx,
      crossOrigin: "trust",
    });
    await withInboxTransaction(fedCtx, (txCtx) =>
      onFollowAccepted(txCtx, accept, { object }),
    );
    return;
  }

  const [object, result] = await Promise.all([
    accept.getObject({ ...fedCtx, suppressError: true }),
    accept.getResult({ ...fedCtx, suppressError: true }),
  ]);

  const handled = await withInboxTransaction(fedCtx, async (txCtx) => {
    if (await onQuoteRequestAccepted(txCtx, accept, { object, result })) {
      return true;
    }
    return await onRelayFollowAccepted(txCtx, accept);
  });
  if (handled || (object != null && !(object instanceof Follow))) return;

  const trustedObject =
    object ?? (await accept.getObject({ ...fedCtx, crossOrigin: "trust" }));
  await withInboxTransaction(fedCtx, (txCtx) =>
    onFollowAccepted(txCtx, accept, { object: trustedObject }),
  );
}

export async function onRejected(
  fedCtx: InboxContext<ContextData>,
  reject: Reject,
): Promise<void> {
  const relayHandled = await withInboxTransaction(fedCtx, (txCtx) =>
    onRelayFollowRejected(txCtx, reject),
  );
  if (relayHandled) return;

  const object = await reject.getObject({ ...fedCtx, suppressError: true });

  const handled = await withInboxTransaction(fedCtx, async (txCtx) => {
    if (await onQuoteRequestRejected(txCtx, reject, { object })) return true;
    return await onFollowRejected(txCtx, reject, { object });
  });
  if (handled || object != null) return;

  const trustedObject = await reject.getObject({
    ...fedCtx,
    crossOrigin: "trust",
  });
  await withInboxTransaction(fedCtx, (txCtx) =>
    onFollowRejected(txCtx, reject, { object: trustedObject }),
  );
}

export async function onFollowReceived(
  fedCtx: InboxContext<ContextData>,
  follow: Follow,
): Promise<void> {
  const follower = await prepareFollower(fedCtx, follow);
  if (follower == null) return;
  await withInboxTransaction(fedCtx, (txCtx) =>
    onFollowed(txCtx, follow, follower),
  );
}

export async function onDeleted(
  fedCtx: InboxContext<ContextData>,
  del: Delete,
): Promise<void> {
  const quoteAuthorizationDeleted = await withInboxTransaction(
    fedCtx,
    (txCtx) => onQuoteAuthorizationDeleted(txCtx, del),
  );
  if (quoteAuthorizationDeleted) return;

  const objectId = del.objectId;
  const actorId = del.actorId;
  if (objectId == null || actorId == null) {
    logger.warn("Unhandled Delete object: {delete}", { delete: del });
    return;
  }
  if (objectId.href === actorId.href) {
    const actorDeleted = await withInboxTransaction(fedCtx, (txCtx) =>
      onActorDeleted(txCtx, del),
    );
    if (!actorDeleted) {
      logger.warn("Unhandled Delete object: {delete}", { delete: del });
    }
    return;
  }
  if (objectId.origin !== actorId.origin) {
    logger.warn("Unhandled Delete object: {delete}", { delete: del });
    return;
  }

  const object = await del.getObject({ ...fedCtx, suppressError: true });
  await withInboxTransaction(fedCtx, async (txCtx) => {
    if (await onPostDeleted(txCtx, del, { object })) return;
    if (await onActorDeleted(txCtx, del)) return;
    logger.warn("Unhandled Delete object: {delete}", { delete: del });
  });
}
