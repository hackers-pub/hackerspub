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
import {
  canActorQuotePost,
  canActorRequestQuotePost,
  isPostObject,
  updateQuotesCount,
} from "@hackerspub/models/post";
import {
  type Actor,
  type Blocking,
  type Following,
  type Mention,
  noteSourceTable,
  type Post,
  postTable,
  quoteAuthorizationTable,
  quoteRequestTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { eq, inArray, sql } from "drizzle-orm";
import { getNote } from "../objects.ts";
import { sendTagsPubRelayActivity } from "../tags-pub.ts";

const logger = getLogger(["hackerspub", "federation", "inbox", "quote"]);

type QuoteWithRelations = Post & {
  actor: Actor;
  quotedPost: (Post & { actor: Actor }) | null;
  replyTarget: Post | null;
  mentions: (Mention & { actor: Actor })[];
};

type QuoteRequestTarget = Post & {
  actor: Actor & {
    followers: Following[];
    blockees: Blocking[];
    blockers: Blocking[];
  };
  mentions: Mention[];
};

const maxQuoteRequestTargetDepth = 16;

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
  const quotedPost = await getQuoteRequestTarget(
    fedCtx,
    request.objectId.href,
    actor,
  );
  if (quotedPost?.actor.accountId == null) return;
  const requestAllowed = canActorRequestQuotePost(quotedPost, actor);
  const validInstrument = requestAllowed &&
    await quoteRequestInstrumentBelongsToActor(fedCtx, request);
  if (!validInstrument) {
    await fedCtx.sendActivity(
      { identifier: quotedPost.actor.accountId },
      { id: request.actorId, inboxId: new URL(actor.inboxUrl) },
      new Reject({
        id: new URL(`#reject`, request.id),
        actor: new URL(quotedPost.actor.iri),
        object: request,
      }),
      { preferSharedInbox: false, orderingKey: request.objectId.href },
    );
    return;
  }
  if (!canActorQuotePost(quotedPost, actor)) return;
  const existingAuthorization = await fedCtx.data.db.query
    .quoteAuthorizationTable.findFirst({
      columns: { id: true, iri: true },
      where: {
        quotePostIri: request.instrumentId.href,
        quotedPostId: quotedPost.id,
        attributedActorId: quotedPost.actorId,
      },
    });
  const authId = existingAuthorization?.id ?? generateUuidV7();
  const authorizationIri = existingAuthorization?.iri ??
    fedCtx.getObjectUri(QuoteAuthorization, { id: authId }).href;
  const response = new Accept({
    id: new URL(`#accept`, request.id),
    actor: new URL(quotedPost.actor.iri),
    object: request,
    result: new URL(authorizationIri),
  });
  await fedCtx.data.db.insert(quoteAuthorizationTable).values({
    id: authId,
    iri: authorizationIri,
    quotePostIri: request.instrumentId.href,
    quotedPostId: quotedPost.id,
    attributedActorId: quotedPost.actorId,
  }).onConflictDoUpdate({
    target: quoteAuthorizationTable.iri,
    set: {
      quotePostIri: request.instrumentId.href,
      quotedPostId: quotedPost.id,
      attributedActorId: quotedPost.actorId,
      revoked: false,
      updated: sql`CURRENT_TIMESTAMP`,
    },
  });
  await fedCtx.sendActivity(
    { identifier: quotedPost.actor.accountId },
    { id: request.actorId, inboxId: new URL(actor.inboxUrl) },
    response,
    { preferSharedInbox: false, orderingKey: request.objectId.href },
  );
}

async function getQuoteRequestTarget(
  fedCtx: InboxContext<ContextData>,
  iri: string,
  actor: Actor,
): Promise<QuoteRequestTarget | undefined> {
  const requested = await fedCtx.data.db.query.postTable.findFirst({
    with: quoteRequestTargetRelations(actor),
    where: { iri },
  });
  if (requested == null) return undefined;

  const visited = new Set([requested.id]);
  let target = requested;
  let depth = 0;
  while (target.sharedPostId != null) {
    if (depth >= maxQuoteRequestTargetDepth) return undefined;
    depth++;
    if (visited.has(target.sharedPostId)) return undefined;
    visited.add(target.sharedPostId);

    const next = await fedCtx.data.db.query.postTable.findFirst({
      with: quoteRequestTargetRelations(actor),
      where: { id: target.sharedPostId },
    });
    if (next == null) return undefined;
    target = next;
  }
  return target;
}

function quoteRequestTargetRelations(actor: Actor) {
  return {
    actor: {
      with: {
        followers: { where: { followerId: actor.id } },
        blockees: { where: { blockeeId: actor.id } },
        blockers: { where: { blockerId: actor.id } },
      },
    },
    mentions: { where: { actorId: actor.id } },
  } as const;
}

async function quoteRequestInstrumentBelongsToActor(
  fedCtx: InboxContext<ContextData>,
  request: QuoteRequest,
): Promise<boolean> {
  if (request.actorId == null || request.instrumentId == null) return false;
  if (request.instrumentId.origin !== request.actorId.origin) {
    logger.warn(
      "Rejecting quote request with cross-origin instrument: {instrument}",
      {
        instrument: request.instrumentId.href,
        actor: request.actorId.href,
      },
    );
    return false;
  }
  let instrument: unknown;
  try {
    instrument = await fedCtx.lookupObject(request.instrumentId);
  } catch (error) {
    logger.warn("Failed to fetch quote request instrument: {instrument}", {
      instrument: request.instrumentId.href,
      error,
    });
    return false;
  }
  if (!isPostObject(instrument)) {
    logger.warn("Rejecting quote request with invalid instrument: {iri}", {
      iri: request.instrumentId.href,
    });
    return false;
  }
  const quotesTarget = instrument.quoteId?.href === request.objectId?.href ||
    instrument.quoteUrl?.href === request.objectId?.href;
  if (!quotesTarget) {
    logger.warn(
      "Rejecting quote request whose instrument does not quote the object.",
      {
        instrument: request.instrumentId.href,
        object: request.objectId?.href,
      },
    );
    return false;
  }
  const belongsToActor = instrument.attributionIds.some((id) =>
    id.href === request.actorId?.href
  );
  if (!belongsToActor) {
    logger.warn(
      "Rejecting quote request whose instrument is not attributed to actor.",
      {
        instrument: request.instrumentId.href,
        actor: request.actorId.href,
      },
    );
  }
  return belongsToActor;
}

export async function onQuoteRequestAccepted(
  fedCtx: InboxContext<ContextData>,
  accept: Accept,
): Promise<boolean> {
  if (accept.actorId == null || accept.resultId == null) return false;
  let quoteRequestIri = accept.objectId?.href;
  const storedRequest = quoteRequestIri == null
    ? undefined
    : await getQuoteRequestForIri(fedCtx, quoteRequestIri);
  let quote = storedRequest?.quotePost;
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
    authorization.id?.href === accept.resultId.href &&
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
  const resultIri = accept.resultId.href;
  const quotedPost = quote.quotedPost;
  const shouldSendUpdate = quote.quoteAuthorizationIri !== resultIri;
  await fedCtx.data.db.transaction(async (tx) => {
    await tx.insert(quoteAuthorizationTable).values({
      id: generateUuidV7(),
      iri: resultIri,
      quotePostIri: quote.iri,
      quotePostId: quote.id,
      quotedPostId: quotedPost.id,
      attributedActorId: quotedPost.actorId,
    }).onConflictDoUpdate({
      target: quoteAuthorizationTable.iri,
      set: {
        quotePostIri: quote.iri,
        quotePostId: quote.id,
        quotedPostId: quotedPost.id,
        attributedActorId: quotedPost.actorId,
        revoked: false,
        updated: acceptedAt,
      },
    });
    if (quoteRequestIri != null) {
      await tx.update(quoteRequestTable)
        .set({
          accepted: acceptedAt,
          rejected: null,
          updated: acceptedAt,
        })
        .where(eq(quoteRequestTable.iri, quoteRequestIri));
    }
    await tx.update(postTable)
      .set({
        quoteAuthorizationIri: resultIri,
        updated: acceptedAt,
      })
      .where(eq(postTable.id, quote.id));
    if (quote.noteSourceId != null) {
      await tx.update(noteSourceTable)
        .set({ updated: acceptedAt })
        .where(eq(noteSourceTable.id, quote.noteSourceId));
    }
  });
  if (shouldSendUpdate) {
    await sendQuoteUpdate(
      fedCtx,
      quote,
      resultIri,
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

async function getQuoteRequestForIri(
  fedCtx: InboxContext<ContextData>,
  quoteRequestIri: string,
): Promise<
  | {
    quotedPostId: Post["id"];
    quotePost: QuoteWithRelations;
  }
  | undefined
> {
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
  if (request?.quotePost == null) return undefined;
  return {
    quotedPostId: request.quotedPostId,
    quotePost: request.quotePost,
  };
}

async function sendQuoteUpdate(
  fedCtx: InboxContext<ContextData>,
  quote: QuoteWithRelations,
  quoteAuthorizationIri: string | null,
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
  if (
    quote.visibility === "public" ||
    quote.visibility === "unlisted" ||
    quote.visibility === "followers"
  ) {
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
  const relayedTags = await sendTagsPubRelayActivity(
    fedCtx,
    quote.actor.accountId,
    update,
    {
      orderingKey: quote.iri,
      visibility: quote.visibility,
      accountBio: noteSource.account.bio,
      relayedTags: quote.relayedTags,
    },
  );
  if (relayedTags != null) {
    await fedCtx.data.db.update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, quote.id));
    quote.relayedTags = [...relayedTags];
  }
}

export async function onQuoteRequestRejected(
  fedCtx: InboxContext<ContextData>,
  reject: Reject,
): Promise<boolean> {
  if (reject.actorId == null) return false;
  let quoteRequestIri = reject.objectId?.href;
  let storedRequest = quoteRequestIri == null
    ? undefined
    : await getQuoteRequestForIri(fedCtx, quoteRequestIri);
  let quote = storedRequest?.quotePost;
  let requestTargetIri: string | undefined;
  if (quote == null) {
    const request = await reject.getObject({ ...fedCtx, suppressError: true });
    if (!(request instanceof QuoteRequest)) return false;
    if (request.instrumentId == null) return false;
    quoteRequestIri = request.id?.href ?? quoteRequestIri;
    requestTargetIri = request.objectId?.href;
    storedRequest = quoteRequestIri == null
      ? undefined
      : await getQuoteRequestForIri(fedCtx, quoteRequestIri);
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
  if (
    storedRequest != null &&
    storedRequest.quotedPostId !== quote.quotedPostId
  ) {
    logger.warn("Ignoring stale quote request rejection for retargeted quote.");
    return true;
  }
  if (
    storedRequest == null && requestTargetIri != null &&
    requestTargetIri !== quote.quotedPost.iri
  ) {
    logger.warn("Ignoring quote request rejection for unexpected target.");
    return true;
  }
  const rejectedAt = new Date();
  const quotedPost = quote.quotedPost;
  const updatedQuote = {
    ...quote,
    quotedPost: null,
    quotedPostId: null,
    quoteAuthorizationIri: null,
    updated: rejectedAt,
  };
  await fedCtx.data.db.transaction(async (tx) => {
    if (quoteRequestIri != null) {
      await tx.update(quoteRequestTable)
        .set({
          accepted: null,
          rejected: rejectedAt,
          updated: rejectedAt,
        })
        .where(eq(quoteRequestTable.iri, quoteRequestIri));
    }
    await tx.update(postTable)
      .set({
        quotedPostId: null,
        quoteAuthorizationIri: null,
        updated: rejectedAt,
      })
      .where(eq(postTable.id, quote.id));
    if (quote.noteSourceId != null) {
      await tx.update(noteSourceTable)
        .set({ updated: rejectedAt })
        .where(eq(noteSourceTable.id, quote.noteSourceId));
    }
    await updateQuotesCount(tx, quotedPost, -1);
  });
  await sendQuoteUpdate(fedCtx, updatedQuote, null, rejectedAt);
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
    return false;
  }
  const authorizationIri = del.objectId.href;
  const quotes = await fedCtx.data.db.query.postTable.findMany({
    with: {
      actor: true,
      quotedPost: { with: { actor: true } },
      replyTarget: true,
      mentions: { with: { actor: true } },
    },
    where: { quoteAuthorizationIri: authorizationIri },
  });
  const revokedAt = new Date();
  const revoked = await fedCtx.data.db.transaction(async (tx) => {
    const rows = await tx.update(quoteAuthorizationTable)
      .set({ revoked: true, updated: revokedAt })
      .where(eq(quoteAuthorizationTable.iri, authorizationIri))
      .returning();
    if (rows.length < 1) return false;
    await tx.update(postTable)
      .set({
        quotedPostId: null,
        quoteAuthorizationIri: null,
        updated: revokedAt,
      })
      .where(eq(postTable.quoteAuthorizationIri, authorizationIri));
    const noteSourceIds = quotes
      .map((quote) => quote.noteSourceId)
      .filter((id) => id != null);
    if (noteSourceIds.length > 0) {
      await tx.update(noteSourceTable)
        .set({ updated: revokedAt })
        .where(inArray(noteSourceTable.id, noteSourceIds));
    }
    if (quotes.length > 0) {
      await updateQuotesCount(
        tx,
        authorization.quotedPost,
        -quotes.length,
      );
    }
    return true;
  });
  if (!revoked) return false;
  for (const quote of quotes) {
    await sendQuoteUpdate(
      fedCtx,
      {
        ...quote,
        quotedPost: null,
        quotedPostId: null,
        quoteAuthorizationIri: null,
        updated: revokedAt,
      },
      null,
      revokedAt,
    );
  }
  logger.debug("Quote authorization deleted: {iri}", {
    iri: del.objectId.href,
  });
  return true;
}
