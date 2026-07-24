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
import { getLogger } from "@logtape/logtape";
import { eq, inArray, sql } from "drizzle-orm";
import {
  getPersistedActor,
  isFederationBlocked,
  persistActor,
} from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import {
  sendActivityWithOutbox,
  toApplicationContext,
  withInboxTransaction,
} from "../context.ts";
import { isPostObject, type PostObject } from "@hackerspub/models/post/core";
import { updateQuotesCount } from "@hackerspub/models/post/engagement";
import { persistPost } from "@hackerspub/models/post/remote";
import {
  canActorQuotePost,
  canActorRequestQuotePost,
  getOriginalPostId,
} from "@hackerspub/models/post/visibility";
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

type ValidQuoteRequestInstrument = {
  instrument: PostObject;
  instrumentIri: string;
};

interface PreparedQuoteRequest {
  actor: NonNullable<Awaited<ReturnType<typeof getPersistedActor>>>;
  validInstrument?: ValidQuoteRequestInstrument;
}

async function prepareQuoteRequest(
  fedCtx: InboxContext<ContextData>,
  request: QuoteRequest,
): Promise<PreparedQuoteRequest | undefined> {
  if (
    request.id == null ||
    request.actorId == null ||
    request.objectId == null ||
    request.instrumentId == null
  ) {
    return;
  }
  let actor = await getPersistedActor(fedCtx.data.db, request.actorId);
  if (actor != null && isFederationBlocked(actor)) return;
  if (actor == null) {
    const actorObject = await request.getActor({
      ...fedCtx,
      suppressError: true,
    });
    if (!isActor(actorObject)) return;
    actor = await persistActor(
      toApplicationContext(fedCtx),
      actorObject,
      fedCtx,
    );
    if (actor == null) return;
  }
  const quotedPost = await getQuoteRequestTarget(
    fedCtx,
    request.objectId.href,
    actor,
  );
  if (quotedPost?.actor.accountId == null) return;
  const requestAllowed =
    quotedPost.censored == null && canActorRequestQuotePost(quotedPost, actor);
  const validInstrument = requestAllowed
    ? await getValidQuoteRequestInstrument(fedCtx, request)
    : undefined;
  return { actor, validInstrument };
}

export async function onQuoteRequestReceived(
  fedCtx: InboxContext<ContextData>,
  request: QuoteRequest,
): Promise<void> {
  const prepared = await prepareQuoteRequest(fedCtx, request);
  if (prepared == null) return;
  await withInboxTransaction(fedCtx, (txCtx) =>
    onQuoteRequested(txCtx, request, prepared),
  );
}

export async function onQuoteRequested(
  fedCtx: InboxContext<ContextData>,
  request: QuoteRequest,
  prepared?: PreparedQuoteRequest,
): Promise<void> {
  if (
    request.id == null ||
    request.actorId == null ||
    request.objectId == null ||
    request.instrumentId == null
  ) {
    return;
  }
  const preparedRequest =
    prepared ?? (await prepareQuoteRequest(fedCtx, request));
  if (preparedRequest == null) return;
  const { actor } = preparedRequest;
  const quotedPost = await getQuoteRequestTarget(
    fedCtx,
    request.objectId.href,
    actor,
  );
  if (quotedPost?.actor.accountId == null) return;
  // A censored post cannot be quoted (the local create-note path enforces the
  // same), so a remote QuoteRequest for it is denied: granting a
  // QuoteAuthorization would let federated users re-amplify content the
  // moderation action makes unquotable.
  const requestAllowed =
    quotedPost.censored == null && canActorRequestQuotePost(quotedPost, actor);
  const validInstrument = requestAllowed
    ? preparedRequest.validInstrument
    : undefined;
  if (validInstrument == null) {
    await sendActivityWithOutbox(
      fedCtx,
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
  const { instrument, instrumentIri } = validInstrument;
  if (!canActorQuotePost(quotedPost, actor)) {
    const existingQuotePost = await fedCtx.data.db.query.postTable.findFirst({
      columns: { id: true },
      where: { iri: instrumentIri },
    });
    const quotePostId =
      existingQuotePost?.id ??
      (
        await persistPost(toApplicationContext(fedCtx), instrument, {
          actor,
          replies: false,
          fetchRemote: false,
        })
      )?.id;
    if (quotePostId == null) return;
    await fedCtx.data.db
      .update(postTable)
      .set({ quoteTargetState: "pending" })
      .where(eq(postTable.id, quotePostId));
    await fedCtx.data.db
      .insert(quoteRequestTable)
      .values({
        id: generateUuidV7(),
        iri: request.id.href,
        quotePostId,
        quotedPostId: quotedPost.id,
      })
      .onConflictDoUpdate({
        target: quoteRequestTable.iri,
        set: {
          quotePostId,
          quotedPostId: quotedPost.id,
          accepted: null,
          rejected: null,
          updated: sql`CURRENT_TIMESTAMP`,
        },
      });
    return;
  }
  const existingAuthorization =
    await fedCtx.data.db.query.quoteAuthorizationTable.findFirst({
      columns: { id: true, iri: true },
      where: {
        quotePostIri: instrumentIri,
        quotedPostId: quotedPost.id,
        attributedActorId: quotedPost.actorId,
      },
    });
  const authId = existingAuthorization?.id ?? generateUuidV7();
  const authorizationIri =
    existingAuthorization?.iri ??
    fedCtx.getObjectUri(QuoteAuthorization, { id: authId }).href;
  const response = new Accept({
    id: new URL(`#accept`, request.id),
    actor: new URL(quotedPost.actor.iri),
    object: request,
    result: new URL(authorizationIri),
  });
  await fedCtx.data.db
    .insert(quoteAuthorizationTable)
    .values({
      id: authId,
      iri: authorizationIri,
      quotePostIri: instrumentIri,
      quotedPostId: quotedPost.id,
      attributedActorId: quotedPost.actorId,
    })
    .onConflictDoUpdate({
      target: quoteAuthorizationTable.iri,
      set: {
        quotePostIri: instrumentIri,
        quotedPostId: quotedPost.id,
        attributedActorId: quotedPost.actorId,
        revoked: false,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    });
  await sendActivityWithOutbox(
    fedCtx,
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
    columns: { id: true, sharedPostId: true },
    where: { iri },
  });
  if (requested == null) return undefined;
  const targetPostId = await getOriginalPostId(fedCtx.data.db, requested);
  if (targetPostId == null) return undefined;
  return await fedCtx.data.db.query.postTable.findFirst({
    with: quoteRequestTargetRelations(actor),
    where: { id: targetPostId },
  });
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

async function getValidQuoteRequestInstrument(
  fedCtx: InboxContext<ContextData>,
  request: QuoteRequest,
): Promise<ValidQuoteRequestInstrument | undefined> {
  if (request.actorId == null || request.instrumentId == null) return undefined;
  const instrumentId = request.instrumentId;
  if (instrumentId.origin !== request.actorId.origin) {
    logger.warn(
      "Rejecting quote request with cross-origin instrument: {instrument}",
      {
        instrument: instrumentId.href,
        actor: request.actorId.href,
      },
    );
    return undefined;
  }
  const instrument = await request.getInstrument({
    ...fedCtx,
    suppressError: true,
    crossOrigin: "trust", // We validate the instrument against actor origin.
  });
  if (instrument == null) {
    logger.warn("Failed to get quote request instrument: {instrument}", {
      instrument: instrumentId.href,
    });
    return undefined;
  }
  if (!isPostObject(instrument)) {
    logger.warn("Rejecting quote request with invalid instrument: {iri}", {
      iri: instrumentId.href,
    });
    return undefined;
  }
  return validateQuoteRequestInstrument(request, instrument, instrumentId);
}

function validateQuoteRequestInstrument(
  request: QuoteRequest,
  instrument: PostObject,
  instrumentId: URL,
): ValidQuoteRequestInstrument | undefined {
  if (request.actorId == null || request.instrumentId == null) return undefined;
  if (
    instrument.id == null ||
    instrument.id.origin !== request.actorId.origin
  ) {
    logger.warn(
      "Rejecting quote request whose instrument id is not on actor origin.",
      {
        instrument: instrument.id?.href,
        actor: request.actorId.href,
      },
    );
    return undefined;
  }
  const quotesTarget =
    instrument.quoteId?.href === request.objectId?.href ||
    instrument.quoteUrl?.href === request.objectId?.href;
  if (!quotesTarget) {
    logger.warn(
      "Rejecting quote request whose instrument does not quote the object.",
      {
        instrument: instrumentId.href,
        object: request.objectId?.href,
      },
    );
    return undefined;
  }
  const belongsToActor = instrument.attributionIds.some(
    (id) => id.href === request.actorId?.href,
  );
  if (!belongsToActor) {
    logger.warn(
      "Rejecting quote request whose instrument is not attributed to actor.",
      {
        instrument: instrumentId.href,
        actor: request.actorId.href,
      },
    );
  }
  return belongsToActor
    ? { instrument, instrumentIri: instrumentId.href }
    : undefined;
}

export async function onQuoteRequestAccepted(
  fedCtx: InboxContext<ContextData>,
  accept: Accept,
  resolved?: Readonly<{ object: unknown; result: unknown }>,
): Promise<boolean> {
  if (accept.actorId == null || accept.resultId == null) return false;
  let quoteRequestIri = accept.objectId?.href;
  let storedRequest =
    quoteRequestIri == null
      ? undefined
      : await getQuoteRequestForIri(fedCtx, quoteRequestIri);
  let quote = storedRequest?.quotePost;
  let quotedPost = storedRequest?.quotedPost;
  if (quote == null) {
    const request =
      resolved == null
        ? await accept.getObject({ ...fedCtx, suppressError: true })
        : resolved.object;
    if (!(request instanceof QuoteRequest)) return false;
    if (request.instrumentId == null) return false;
    quoteRequestIri = request.id?.href ?? quoteRequestIri;
    storedRequest =
      quoteRequestIri == null
        ? undefined
        : await getQuoteRequestForIri(fedCtx, quoteRequestIri);
    quote =
      storedRequest?.quotePost ??
      (await getQuoteForQuoteRequestInstrument(
        fedCtx,
        request.instrumentId.href,
      ));
    quotedPost = storedRequest?.quotedPost;
    if (quote == null) return true;
  }
  quotedPost ??= quote.quotedPost ?? undefined;
  if (quotedPost == null || quotedPost.actor.iri !== accept.actorId.href) {
    logger.warn("Ignoring quote request acceptance from unexpected actor.");
    return true;
  }
  if (
    storedRequest != null &&
    quote.quotedPostId != null &&
    storedRequest.quotedPostId !== quote.quotedPostId
  ) {
    logger.warn(
      "Ignoring stale quote request acceptance for retargeted quote.",
    );
    return true;
  }
  const authorization =
    resolved == null
      ? await accept.getResult({
          ...fedCtx,
          suppressError: true,
        })
      : resolved.result;
  const validAuthorization =
    authorization instanceof QuoteAuthorization &&
    authorization.id?.href === accept.resultId.href &&
    authorization.interactingObjectId?.href === quote.iri &&
    authorization.interactionTargetId?.href === quotedPost.iri &&
    authorization.attributionId?.href === quotedPost.actor.iri;
  if (!validAuthorization) {
    logger.warn("Ignoring invalid quote authorization: {iri}", {
      iri: accept.resultId.href,
    });
    return true;
  }
  const accepted = new Date();
  const resultIri = accept.resultId.href;
  const shouldSendUpdate =
    quote.quoteAuthorizationIri !== resultIri ||
    quote.quotedPostId !== quotedPost.id;
  await fedCtx.data.db.transaction(async (tx) => {
    await tx
      .insert(quoteAuthorizationTable)
      .values({
        id: generateUuidV7(),
        iri: resultIri,
        quotePostIri: quote.iri,
        quotePostId: quote.id,
        quotedPostId: quotedPost.id,
        attributedActorId: quotedPost.actorId,
      })
      .onConflictDoUpdate({
        target: quoteAuthorizationTable.iri,
        set: {
          quotePostIri: quote.iri,
          quotePostId: quote.id,
          quotedPostId: quotedPost.id,
          attributedActorId: quotedPost.actorId,
          revoked: false,
          updated: accepted,
        },
      });
    if (quoteRequestIri != null) {
      await tx
        .update(quoteRequestTable)
        .set({
          accepted,
          rejected: null,
          updated: accepted,
        })
        .where(eq(quoteRequestTable.iri, quoteRequestIri));
    }
    await tx
      .update(postTable)
      .set({
        quotedPostId: quotedPost.id,
        quoteAuthorizationIri: resultIri,
        quoteTargetState: null,
        updated: accepted,
      })
      .where(eq(postTable.id, quote.id));
    if (quote.noteSourceId != null) {
      await tx
        .update(noteSourceTable)
        .set({ updated: accepted })
        .where(eq(noteSourceTable.id, quote.noteSourceId));
    }
    if (quote.quotedPostId !== quotedPost.id) {
      await updateQuotesCount(tx, quotedPost, 1);
    }
  });
  if (shouldSendUpdate) {
    await sendQuoteUpdate(
      fedCtx,
      {
        ...quote,
        quotedPost,
        quotedPostId: quotedPost.id,
        quoteAuthorizationIri: resultIri,
        quoteTargetState: null,
        updated: accepted,
      },
      resultIri,
      accepted,
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
      quotedPost: Post & { actor: Actor };
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
      quotedPost: { with: { actor: true } },
    },
    where: { iri: quoteRequestIri },
  });
  if (request?.quotePost == null || request.quotedPost == null) {
    return undefined;
  }
  return {
    quotedPostId: request.quotedPostId,
    quotedPost: request.quotedPost,
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
    replyTargetId:
      quote.replyTarget == null ? undefined : new URL(quote.replyTarget.iri),
    quotedPost: quote.quotedPost ?? undefined,
    quoteAuthorizationIri,
  });
  const update = new Update({
    id: new URL(
      `#update/${updated.toISOString()}`,
      noteObject.id ?? fedCtx.canonicalOrigin,
    ),
    actor: fedCtx.getActorUri(quote.actor.accountId),
    tos: noteObject.toIds,
    ccs: noteObject.ccIds,
    object: noteObject,
  });
  const excludeBaseUris = [
    new URL(fedCtx.origin),
    new URL(fedCtx.canonicalOrigin),
  ];
  if (quote.mentions.length > 0) {
    await sendActivityWithOutbox(
      fedCtx,
      { identifier: quote.actor.accountId },
      quote.mentions.map((mention) => ({
        id: new URL(mention.actor.iri),
        inboxId: new URL(mention.actor.inboxUrl),
        endpoints:
          mention.actor.sharedInboxUrl == null
            ? null
            : {
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
    await sendActivityWithOutbox(
      fedCtx,
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
    await fedCtx.data.db
      .update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, quote.id));
    quote.relayedTags = [...relayedTags];
  }
}

export async function onQuoteRequestRejected(
  fedCtx: InboxContext<ContextData>,
  reject: Reject,
  resolved?: Readonly<{ object: unknown }>,
): Promise<boolean> {
  if (reject.actorId == null) return false;
  let quoteRequestIri = reject.objectId?.href;
  let storedRequest =
    quoteRequestIri == null
      ? undefined
      : await getQuoteRequestForIri(fedCtx, quoteRequestIri);
  let quote = storedRequest?.quotePost;
  let quotedPost = storedRequest?.quotedPost;
  let requestTargetIri: string | undefined;
  if (quote == null) {
    const request =
      resolved == null
        ? await reject.getObject({ ...fedCtx, suppressError: true })
        : resolved.object;
    if (!(request instanceof QuoteRequest)) return false;
    if (request.instrumentId == null) return false;
    quoteRequestIri = request.id?.href ?? quoteRequestIri;
    requestTargetIri = request.objectId?.href;
    storedRequest =
      quoteRequestIri == null
        ? undefined
        : await getQuoteRequestForIri(fedCtx, quoteRequestIri);
    quote = await getQuoteForQuoteRequestInstrument(
      fedCtx,
      request.instrumentId.href,
    );
    if (quote == null) return true;
  }
  quotedPost ??= quote.quotedPost ?? undefined;
  if (quotedPost == null) return true;
  if (quotedPost.actor.iri !== reject.actorId.href) {
    logger.warn("Ignoring quote request rejection from unexpected actor.");
    return true;
  }
  if (
    storedRequest != null &&
    quote.quotedPostId != null &&
    storedRequest.quotedPostId !== quote.quotedPostId
  ) {
    logger.warn("Ignoring stale quote request rejection for retargeted quote.");
    return true;
  }
  if (
    storedRequest == null &&
    requestTargetIri != null &&
    requestTargetIri !== quotedPost.iri
  ) {
    logger.warn("Ignoring quote request rejection for unexpected target.");
    return true;
  }
  const rejected = new Date();
  const updatedQuote = {
    ...quote,
    quotedPost: null,
    quotedPostId: null,
    quoteAuthorizationIri: null,
    quoteTargetState: "denied" as const,
    updated: rejected,
  };
  await fedCtx.data.db.transaction(async (tx) => {
    if (quoteRequestIri != null) {
      await tx
        .update(quoteRequestTable)
        .set({
          accepted: null,
          rejected,
          updated: rejected,
        })
        .where(eq(quoteRequestTable.iri, quoteRequestIri));
    }
    await tx
      .update(postTable)
      .set({
        quotedPostId: null,
        quoteAuthorizationIri: null,
        quoteTargetState: "denied",
        updated: rejected,
      })
      .where(eq(postTable.id, quote.id));
    if (quote.noteSourceId != null) {
      await tx
        .update(noteSourceTable)
        .set({ updated: rejected })
        .where(eq(noteSourceTable.id, quote.noteSourceId));
    }
    if (quote.quotedPostId === quotedPost.id) {
      await updateQuotesCount(tx, quotedPost, -1);
    }
  });
  if (quote.quotedPostId === quotedPost.id) {
    await sendQuoteUpdate(fedCtx, updatedQuote, null, rejected);
  }
  return true;
}

export async function onQuoteAuthorizationDeleted(
  fedCtx: InboxContext<ContextData>,
  del: Delete,
): Promise<boolean> {
  if (del.actorId == null || del.objectId == null) return false;
  const authorization =
    await fedCtx.data.db.query.quoteAuthorizationTable.findFirst({
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
  const revokedTime = new Date();
  const revoked = await fedCtx.data.db.transaction(async (tx) => {
    const rows = await tx
      .update(quoteAuthorizationTable)
      .set({ revoked: true, updated: revokedTime })
      .where(eq(quoteAuthorizationTable.iri, authorizationIri))
      .returning();
    if (rows.length < 1) return false;
    await tx
      .update(postTable)
      .set({
        quotedPostId: null,
        quoteAuthorizationIri: null,
        quoteTargetState: "denied",
        updated: revokedTime,
      })
      .where(eq(postTable.quoteAuthorizationIri, authorizationIri));
    const noteSourceIds = quotes
      .map((quote) => quote.noteSourceId)
      .filter((id) => id != null);
    if (noteSourceIds.length > 0) {
      await tx
        .update(noteSourceTable)
        .set({ updated: revokedTime })
        .where(inArray(noteSourceTable.id, noteSourceIds));
    }
    if (quotes.length > 0) {
      await updateQuotesCount(tx, authorization.quotedPost, -quotes.length);
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
        quoteTargetState: "denied" as const,
        updated: revokedTime,
      },
      null,
      revokedTime,
    );
  }
  logger.debug("Quote authorization deleted: {iri}", {
    iri: del.objectId.href,
  });
  return true;
}
