import type { InboxContext } from "@fedify/fedify";
import {
  Accept,
  type Delete,
  isActor,
  QuoteAuthorization,
  QuoteRequest,
  Reject,
  Update,
} from "@fedify/vocab";
import { getPersistedActor, persistActor } from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import { canActorQuotePost, updateQuotesCount } from "@hackerspub/models/post";
import {
  type Actor,
  type Mention,
  noteSourceTable,
  type Post,
  postTable,
  quoteAuthorizationTable,
  quoteRequestTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { eq, sql } from "drizzle-orm";
import { getNote } from "../objects.ts";

const logger = getLogger(["hackerspub", "federation", "inbox", "quote"]);

type QuoteWithRelations = Post & {
  actor: Actor;
  quotedPost: (Post & { actor: Actor }) | null;
  replyTarget: Post | null;
  mentions: (Mention & { actor: Actor })[];
};

export async function onQuoteRequested(
  fedCtx: InboxContext<ContextData>,
  request: QuoteRequest,
): Promise<void> {
  if (
    request.id == null || request.actorId == null || request.objectId == null ||
    request.instrumentId == null
  ) {
    return;
  }
  let actor = await getPersistedActor(fedCtx.data.db, request.actorId);
  if (actor == null) {
    const actorObject = await request.getActor({
      ...fedCtx,
      suppressError: true,
    });
    if (!isActor(actorObject)) return;
    actor = await persistActor(fedCtx, actorObject, fedCtx);
    if (actor == null) return;
  }
  const quotedPost = await fedCtx.data.db.query.postTable.findFirst({
    with: {
      actor: {
        with: {
          followers: { where: { followerId: actor.id } },
          blockees: { where: { blockeeId: actor.id } },
          blockers: { where: { blockerId: actor.id } },
        },
      },
      mentions: { where: { actorId: actor.id } },
    },
    where: { iri: request.objectId.href },
  });
  if (quotedPost?.actor.accountId == null) return;
  const approved = canActorQuotePost(quotedPost, actor);
  const authId = generateUuidV7();
  const authorizationIri = fedCtx.getObjectUri(QuoteAuthorization, {
    id: authId,
  }).href;
  const response = approved
    ? new Accept({
      id: new URL(`#accept`, request.id),
      actor: new URL(quotedPost.actor.iri),
      object: request,
      result: new URL(authorizationIri),
    })
    : new Reject({
      id: new URL(`#reject`, request.id),
      actor: new URL(quotedPost.actor.iri),
      object: request,
    });
  if (approved) {
    await fedCtx.data.db.insert(quoteAuthorizationTable).values({
      id: authId,
      iri: authorizationIri,
      quotePostIri: request.instrumentId.href,
      quotedPostId: quotedPost.id,
      attributedActorId: quotedPost.actorId,
    }).onConflictDoUpdate({
      target: quoteAuthorizationTable.iri,
      set: { revoked: false, updated: sql`CURRENT_TIMESTAMP` },
    });
  }
  await fedCtx.sendActivity(
    { identifier: quotedPost.actor.accountId },
    { id: request.actorId, inboxId: new URL(actor.inboxUrl) },
    response,
    { preferSharedInbox: false, orderingKey: request.objectId.href },
  );
}

export async function onQuoteRequestAccepted(
  fedCtx: InboxContext<ContextData>,
  accept: Accept,
): Promise<boolean> {
  if (accept.actorId == null || accept.resultId == null) return false;
  let quoteRequestIri = accept.objectId?.href;
  let quote = quoteRequestIri == null
    ? undefined
    : await getQuoteForQuoteRequestIri(fedCtx, quoteRequestIri);
  if (quote == null) {
    const request = await accept.getObject({ ...fedCtx, suppressError: true });
    if (!(request instanceof QuoteRequest)) return false;
    if (request.instrumentId == null) return false;
    quoteRequestIri = request.id?.href ?? quoteRequestIri;
    quote = await getQuoteForQuoteRequestInstrument(
      fedCtx,
      request.instrumentId.href,
    );
    if (quote == null) return true;
  }
  if (
    quote.quotedPost == null ||
    quote.quotedPost.actor.iri !== accept.actorId.href
  ) {
    logger.warn("Ignoring quote request acceptance from unexpected actor.");
    return true;
  }
  const authorization = await accept.getResult({
    ...fedCtx,
    suppressError: true,
  });
  const validAuthorization = authorization instanceof QuoteAuthorization &&
    authorization.interactingObjectId?.href === quote.iri &&
    authorization.interactionTargetId?.href === quote.quotedPost.iri &&
    authorization.attributionId?.href === quote.quotedPost.actor.iri;
  if (!validAuthorization) {
    logger.warn("Ignoring invalid quote authorization: {iri}", {
      iri: accept.resultId.href,
    });
    return true;
  }
  const acceptedAt = new Date();
  await fedCtx.data.db.insert(quoteAuthorizationTable).values({
    id: generateUuidV7(),
    iri: accept.resultId.href,
    quotePostIri: quote.iri,
    quotePostId: quote.id,
    quotedPostId: quote.quotedPost.id,
    attributedActorId: quote.quotedPost.actorId,
  }).onConflictDoUpdate({
    target: quoteAuthorizationTable.iri,
    set: {
      quotePostIri: quote.iri,
      quotePostId: quote.id,
      quotedPostId: quote.quotedPost.id,
      attributedActorId: quote.quotedPost.actorId,
      revoked: false,
      updated: acceptedAt,
    },
  });
  if (quoteRequestIri != null) {
    await fedCtx.data.db.update(quoteRequestTable)
      .set({
        accepted: acceptedAt,
        rejected: null,
        updated: acceptedAt,
      })
      .where(eq(quoteRequestTable.iri, quoteRequestIri));
  }
  const shouldSendUpdate = quote.quoteAuthorizationIri !== accept.resultId.href;
  await fedCtx.data.db.update(postTable)
    .set({
      quoteAuthorizationIri: accept.resultId.href,
      updated: acceptedAt,
    })
    .where(eq(postTable.id, quote.id));
  if (quote.noteSourceId != null) {
    await fedCtx.data.db.update(noteSourceTable)
      .set({ updated: acceptedAt })
      .where(eq(noteSourceTable.id, quote.noteSourceId));
  }
  if (shouldSendUpdate) {
    await sendQuoteUpdate(
      fedCtx,
      quote,
      accept.resultId.href,
      acceptedAt,
    );
  }
  return true;
}

async function getQuoteForQuoteRequestInstrument(
  fedCtx: InboxContext<ContextData>,
  quotePostIri: string,
): Promise<QuoteWithRelations | undefined> {
  return await fedCtx.data.db.query.postTable.findFirst({
    with: {
      actor: true,
      quotedPost: { with: { actor: true } },
      replyTarget: true,
      mentions: { with: { actor: true } },
    },
    where: { iri: quotePostIri },
  });
}

async function getQuoteForQuoteRequestIri(
  fedCtx: InboxContext<ContextData>,
  quoteRequestIri: string,
): Promise<QuoteWithRelations | undefined> {
  const request = await fedCtx.data.db.query.quoteRequestTable.findFirst({
    with: {
      quotePost: {
        with: {
          actor: true,
          quotedPost: { with: { actor: true } },
          replyTarget: true,
          mentions: { with: { actor: true } },
        },
      },
    },
    where: { iri: quoteRequestIri },
  });
  return request?.quotePost;
}

async function sendQuoteUpdate(
  fedCtx: InboxContext<ContextData>,
  quote: QuoteWithRelations,
  quoteAuthorizationIri: string,
  updated: Date,
): Promise<void> {
  if (quote.actor.accountId == null || quote.noteSourceId == null) return;
  const noteSource = await fedCtx.data.db.query.noteSourceTable.findFirst({
    where: { id: quote.noteSourceId },
    with: {
      account: true,
      media: { with: { medium: true }, orderBy: { index: "asc" } },
    },
  });
  if (noteSource == null) return;
  const noteObject = await getNote(fedCtx, noteSource, {
    replyTargetId: quote.replyTarget == null
      ? undefined
      : new URL(quote.replyTarget.iri),
    quotedPost: quote.quotedPost ?? undefined,
    quoteAuthorizationIri,
  });
  const update = new Update({
    id: new URL(
      `#update/${updated.toISOString()}`,
      noteObject.id ?? fedCtx.canonicalOrigin,
    ),
    actors: noteObject.attributionIds,
    tos: noteObject.toIds,
    ccs: noteObject.ccIds,
    object: noteObject,
  });
  const excludeBaseUris = [
    new URL(fedCtx.origin),
    new URL(fedCtx.canonicalOrigin),
  ];
  if (quote.mentions.length > 0) {
    await fedCtx.sendActivity(
      { identifier: quote.actor.accountId },
      quote.mentions.map((mention) => ({
        id: new URL(mention.actor.iri),
        inboxId: new URL(mention.actor.inboxUrl),
        endpoints: mention.actor.sharedInboxUrl == null ? null : {
          sharedInbox: new URL(mention.actor.sharedInboxUrl),
        },
      })),
      update,
      {
        orderingKey: quote.iri,
        preferSharedInbox: false,
        excludeBaseUris,
      },
    );
  }
  if (quote.visibility !== "direct") {
    await fedCtx.sendActivity(
      { identifier: quote.actor.accountId },
      "followers",
      update,
      {
        orderingKey: quote.iri,
        preferSharedInbox: true,
        excludeBaseUris,
      },
    );
  }
}

export async function onQuoteRequestRejected(
  fedCtx: InboxContext<ContextData>,
  reject: Reject,
): Promise<boolean> {
  if (reject.actorId == null) return false;
  let quoteRequestIri = reject.objectId?.href;
  let quote = quoteRequestIri == null
    ? undefined
    : await getQuoteForQuoteRequestIri(fedCtx, quoteRequestIri);
  if (quote == null) {
    const request = await reject.getObject({ ...fedCtx, suppressError: true });
    if (!(request instanceof QuoteRequest)) return false;
    if (request.instrumentId == null) return false;
    quoteRequestIri = request.id?.href ?? quoteRequestIri;
    quote = await getQuoteForQuoteRequestInstrument(
      fedCtx,
      request.instrumentId.href,
    );
    if (quote == null) return true;
  }
  if (quote.quotedPost == null) return true;
  if (quote.quotedPost.actor.iri !== reject.actorId.href) {
    logger.warn("Ignoring quote request rejection from unexpected actor.");
    return true;
  }
  const rejectedAt = new Date();
  if (quoteRequestIri != null) {
    await fedCtx.data.db.update(quoteRequestTable)
      .set({
        accepted: null,
        rejected: rejectedAt,
        updated: rejectedAt,
      })
      .where(eq(quoteRequestTable.iri, quoteRequestIri));
  }
  await fedCtx.data.db.update(postTable)
    .set({
      quotedPostId: null,
      quoteAuthorizationIri: null,
      updated: rejectedAt,
    })
    .where(eq(postTable.id, quote.id));
  await updateQuotesCount(fedCtx.data.db, quote.quotedPost, -1);
  return true;
}

export async function onQuoteAuthorizationDeleted(
  fedCtx: InboxContext<ContextData>,
  del: Delete,
): Promise<boolean> {
  if (del.actorId == null || del.objectId == null) return false;
  const authorization = await fedCtx.data.db.query.quoteAuthorizationTable
    .findFirst({
      with: { attributedActor: true, quotedPost: true },
      where: { iri: del.objectId.href },
    });
  if (authorization == null) return false;
  if (authorization.attributedActor.iri !== del.actorId.href) {
    logger.warn(
      "Ignoring quote authorization deletion by non-attributed actor: {iri}",
      { iri: del.objectId.href },
    );
    return true;
  }
  const rows = await fedCtx.data.db.update(quoteAuthorizationTable)
    .set({ revoked: true, updated: sql`CURRENT_TIMESTAMP` })
    .where(eq(quoteAuthorizationTable.iri, del.objectId.href))
    .returning();
  if (rows.length < 1) return false;
  await fedCtx.data.db.update(postTable)
    .set({
      quotedPostId: null,
      quoteAuthorizationIri: null,
      updated: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(postTable.quoteAuthorizationIri, del.objectId.href));
  await updateQuotesCount(fedCtx.data.db, authorization.quotedPost, -1);
  logger.debug("Quote authorization deleted: {iri}", {
    iri: del.objectId.href,
  });
  return true;
}
