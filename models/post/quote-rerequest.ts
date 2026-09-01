import * as vocab from "@fedify/vocab";
import {
  aliasedTable,
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { isFederationBlocked } from "../actor.ts";
import { getBlockedActorIds, getBlockerActorIds } from "../blocking.ts";
import type { ApplicationContext } from "../context.ts";
import type { Database } from "../db.ts";
import { isActorSuspended } from "../moderation.ts";
import { actorTable, postTable, quoteRequestTable } from "../schema.ts";
import { withTransaction } from "../tx.ts";
import { generateUuidV7, type Uuid } from "../uuid.ts";

export type QuoteAuthorizationRerequestSkipReason =
  | "already-authorized"
  | "already-pending"
  | "ambiguous-pending-target"
  | "blocked-relationship"
  | "blocked-target"
  | "censored"
  | "local-target"
  | "missing-poll"
  | "missing-source"
  | "not-a-quote"
  | "not-local"
  | "private-quote"
  | "private-target"
  | "self-quote"
  | "suspended-author"
  | "unsupported-type";

export type QuoteAuthorizationRerequestResult =
  | {
      readonly status: "eligible";
      readonly postId: Uuid;
      readonly noteSourceId: Uuid;
      readonly postIri: string;
      readonly quotedPostIri: string;
    }
  | {
      readonly status: "requested";
      readonly postId: Uuid;
      readonly noteSourceId: Uuid;
      readonly postIri: string;
      readonly quotedPostIri: string;
      readonly requestIri: string;
    }
  | {
      readonly status: "skipped";
      readonly postId: Uuid;
      readonly noteSourceId: Uuid | null;
      readonly postIri: string;
      readonly reason: QuoteAuthorizationRerequestSkipReason;
    };

/**
 * Find posts that may need a retrospective FEP-044f `QuoteRequest`.
 *
 * A UUID selects either the post row or its local note source.  Without one,
 * the query deliberately stays narrow: only source-backed local Notes and
 * Questions that still expose a quote without an authorization are returned,
 * including pending requests that have not been preceded by an `Update`.  The
 * operation re-checks all invariants while holding a row lock.
 */
export async function findQuoteAuthorizationRerequestPostIds(
  db: Database,
  uuid?: Uuid,
): Promise<Uuid[]> {
  let rows: { id: Uuid }[];
  if (uuid == null) {
    const author = aliasedTable(actorTable, "quote_rerequest_author");
    const quotedPost = aliasedTable(postTable, "quote_rerequest_target");
    const quotedActor = aliasedTable(
      actorTable,
      "quote_rerequest_target_actor",
    );
    const attachedRows = await db
      .select({ id: postTable.id })
      .from(postTable)
      .innerJoin(author, eq(author.id, postTable.actorId))
      .innerJoin(quotedPost, eq(quotedPost.id, postTable.quotedPostId))
      .innerJoin(quotedActor, eq(quotedActor.id, quotedPost.actorId))
      .where(
        and(
          isNotNull(author.accountId),
          isNull(quotedActor.accountId),
          ne(postTable.actorId, quotedPost.actorId),
          isNull(postTable.censored),
          isNull(quotedPost.censored),
          isNotNull(postTable.noteSourceId),
          inArray(postTable.type, ["Note", "Question"]),
          isNotNull(postTable.quotedPostId),
          isNull(postTable.quoteAuthorizationIri),
          isNull(postTable.quoteTargetState),
        ),
      )
      .orderBy(postTable.published, postTable.id);
    const pendingPost = aliasedTable(postTable, "quote_rerequest_pending");
    const pendingAuthor = aliasedTable(
      actorTable,
      "quote_rerequest_pending_author",
    );
    const pendingTarget = aliasedTable(
      postTable,
      "quote_rerequest_pending_target",
    );
    const pendingTargetActor = aliasedTable(
      actorTable,
      "quote_rerequest_pending_target_actor",
    );
    const pendingRows = await db
      .select({ id: pendingPost.id })
      .from(quoteRequestTable)
      .innerJoin(pendingPost, eq(pendingPost.id, quoteRequestTable.quotePostId))
      .innerJoin(pendingAuthor, eq(pendingAuthor.id, pendingPost.actorId))
      .innerJoin(
        pendingTarget,
        eq(pendingTarget.id, quoteRequestTable.quotedPostId),
      )
      .innerJoin(
        pendingTargetActor,
        eq(pendingTargetActor.id, pendingTarget.actorId),
      )
      .where(
        and(
          isNotNull(pendingAuthor.accountId),
          isNull(pendingTargetActor.accountId),
          ne(pendingPost.actorId, pendingTarget.actorId),
          isNull(pendingPost.censored),
          isNull(pendingTarget.censored),
          isNotNull(pendingPost.noteSourceId),
          inArray(pendingPost.type, ["Note", "Question"]),
          isNull(pendingPost.quoteAuthorizationIri),
          eq(pendingPost.quoteTargetState, "pending"),
          isNull(quoteRequestTable.accepted),
          isNull(quoteRequestTable.rejected),
          isNull(quoteRequestTable.superseded),
          eq(quoteRequestTable.objectUpdated, false),
        ),
      )
      .orderBy(pendingPost.published, pendingPost.id);
    rows = [...attachedRows, ...pendingRows];
  } else {
    rows = await db
      .select({ id: postTable.id })
      .from(postTable)
      .where(or(eq(postTable.id, uuid), eq(postTable.noteSourceId, uuid)));
  }
  return [...new Set(rows.map((row) => row.id))];
}

export async function rerequestQuoteAuthorization(
  context: ApplicationContext,
  postId: Uuid,
  options: { readonly dryRun?: boolean } = {},
): Promise<QuoteAuthorizationRerequestResult> {
  return await withTransaction(context, async (txCtx) => {
    const { db } = txCtx;
    await db.execute(sql`SELECT ${postTable.id}
      FROM ${postTable}
      WHERE ${postTable.id} = ${postId}
      FOR UPDATE`);
    const post = await db.query.postTable.findFirst({
      where: { id: postId },
      with: {
        actor: true,
        noteSource: {
          with: {
            account: true,
            media: {
              with: { medium: true },
              orderBy: { index: "asc" },
            },
          },
        },
        poll: {
          with: { options: { orderBy: { index: "asc" } } },
        },
        quotedPost: { with: { actor: true } },
        replyTarget: true,
      },
    });
    if (post == null) {
      throw new Error(`Post not found: ${postId}`);
    }

    const skip = (
      reason: QuoteAuthorizationRerequestSkipReason,
    ): QuoteAuthorizationRerequestResult => ({
      status: "skipped",
      postId: post.id,
      noteSourceId: post.noteSourceId,
      postIri: post.iri,
      reason,
    });
    if (post.actor.accountId == null) return skip("not-local");
    if (isActorSuspended(post.actor)) return skip("suspended-author");
    if (post.noteSourceId == null || post.noteSource == null) {
      return skip("missing-source");
    }
    if (post.type !== "Note" && post.type !== "Question") {
      return skip("unsupported-type");
    }
    if (post.censored != null) return skip("censored");
    if (post.visibility === "direct" || post.visibility === "none") {
      return skip("private-quote");
    }
    if (post.quoteAuthorizationIri != null) {
      return skip("already-authorized");
    }
    const activeRequests = await db.query.quoteRequestTable.findMany({
      columns: { id: true, objectUpdated: true, quotedPostId: true },
      where: {
        quotePostId: post.id,
        accepted: { isNull: true },
        rejected: { isNull: true },
        superseded: { isNull: true },
      },
      with: { quotedPost: { with: { actor: true } } },
    });
    let quotedPost = post.quotedPost;
    if (quotedPost == null) {
      if (activeRequests.some((request) => request.objectUpdated)) {
        return skip("already-pending");
      }
      const targetIds = new Set(
        activeRequests.map((request) => request.quotedPostId),
      );
      if (targetIds.size > 1) return skip("ambiguous-pending-target");
      quotedPost = activeRequests[0]?.quotedPost ?? null;
    }
    if (quotedPost == null) return skip("not-a-quote");
    const pendingRequests = activeRequests.filter(
      (request) => request.quotedPostId === quotedPost.id,
    );
    if (
      pendingRequests.some((request) => request.objectUpdated) ||
      (pendingRequests.length < 1 && post.quoteTargetState === "pending")
    ) {
      return skip("already-pending");
    }
    if (quotedPost.actorId === post.actorId) return skip("self-quote");
    if (isFederationBlocked(quotedPost.actor)) {
      return skip("blocked-target");
    }
    if (
      quotedPost.actor.accountId != null ||
      new URL(quotedPost.iri).origin ===
        new URL(txCtx.canonicalOrigin).origin ||
      new URL(quotedPost.actor.iri).origin ===
        new URL(txCtx.canonicalOrigin).origin
    ) {
      return skip("local-target");
    }
    const [blockedTargets, blockingTargets] = await Promise.all([
      getBlockedActorIds(db, post.actorId, [quotedPost.actorId]),
      getBlockerActorIds(db, post.actorId, [quotedPost.actorId]),
    ]);
    if (
      blockedTargets.has(quotedPost.actorId) ||
      blockingTargets.has(quotedPost.actorId)
    ) {
      return skip("blocked-relationship");
    }
    if (
      quotedPost.visibility === "direct" ||
      quotedPost.visibility === "none" ||
      quotedPost.censored != null
    ) {
      return skip("private-target");
    }
    if (post.type === "Question" && post.poll == null) {
      return skip("missing-poll");
    }
    const baseResult = {
      postId: post.id,
      noteSourceId: post.noteSourceId,
      postIri: post.iri,
      quotedPostIri: quotedPost.iri,
    };
    if (options.dryRun) return { status: "eligible", ...baseResult };

    const relations = {
      ...(post.replyTarget == null
        ? {}
        : { replyTargetId: new URL(post.replyTarget.iri) }),
      quotedPost,
      quoteRequestPolicy: post.quoteRequestPolicy,
    };
    let instrument: vocab.Note | vocab.Question;
    if (post.type === "Question") {
      const poll = post.poll;
      if (poll == null) return skip("missing-poll");
      instrument = await txCtx.services.federation.getQuestion(
        txCtx,
        post.noteSource,
        { ...poll, post, options: poll.options },
        relations,
      );
    } else {
      instrument = await txCtx.services.federation.getNote(
        txCtx,
        post.noteSource,
        relations,
      );
    }
    const requestId = new URL(`#quote-request/${generateUuidV7()}`, post.iri);
    const updateId = new URL(`#update/${generateUuidV7()}`, post.iri);
    const targetActorId = new URL(quotedPost.actor.iri);
    const update = new vocab.Update({
      id: updateId,
      actor: txCtx.getActorUri(post.noteSource.accountId),
      tos: instrument.toIds,
      // Explicitly address the quoted actor so a shared inbox can route the
      // otherwise public Update before it receives the QuoteRequest.
      ccs: [...instrument.ccIds, targetActorId],
      object: instrument,
    });
    const request = new vocab.QuoteRequest({
      id: requestId,
      actor: txCtx.getActorUri(post.noteSource.accountId),
      object: new URL(quotedPost.iri),
      instrument,
    });

    const now = new Date();
    await db
      .update(postTable)
      .set({ quoteTargetState: "pending" })
      .where(
        and(
          eq(postTable.id, post.id),
          isNull(postTable.quoteAuthorizationIri),
          or(
            eq(postTable.quotedPostId, quotedPost.id),
            and(
              isNull(postTable.quotedPostId),
              eq(postTable.quoteTargetState, "pending"),
            ),
          ),
        ),
      );
    if (pendingRequests.length > 0) {
      await db
        .update(quoteRequestTable)
        .set({ superseded: now, updated: now })
        .where(
          and(
            eq(quoteRequestTable.quotePostId, post.id),
            eq(quoteRequestTable.quotedPostId, quotedPost.id),
            isNull(quoteRequestTable.accepted),
            isNull(quoteRequestTable.rejected),
            isNull(quoteRequestTable.superseded),
            eq(quoteRequestTable.objectUpdated, false),
          ),
        );
    }
    await db.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestId.href,
      quotePostId: post.id,
      quotedPostId: quotedPost.id,
      objectUpdated: true,
    });
    const recipient = {
      id: targetActorId,
      inboxId: new URL(quotedPost.actor.inboxUrl),
      endpoints:
        quotedPost.actor.sharedInboxUrl == null
          ? null
          : { sharedInbox: new URL(quotedPost.actor.sharedInboxUrl) },
    };
    const deliveryOptions = {
      orderingKey: post.iri,
      preferSharedInbox: true,
    } as const;
    await txCtx.sendActivity(
      { identifier: post.noteSource.accountId },
      recipient,
      update,
      deliveryOptions,
    );
    await txCtx.sendActivity(
      { identifier: post.noteSource.accountId },
      recipient,
      request,
      deliveryOptions,
    );
    return {
      status: "requested",
      ...baseResult,
      requestIri: requestId.href,
    };
  });
}
