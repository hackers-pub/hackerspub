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
 * Questions that still expose a quote without an authorization are returned.
 * The operation re-checks all invariants while holding a row lock.
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
    rows = await db
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
  } else {
    rows = await db
      .select({ id: postTable.id })
      .from(postTable)
      .where(or(eq(postTable.id, uuid), eq(postTable.noteSourceId, uuid)));
  }
  return rows.map((row) => row.id);
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
    if (post.quotedPost == null) return skip("not-a-quote");
    if (post.quotedPost.actorId === post.actorId) return skip("self-quote");
    if (isFederationBlocked(post.quotedPost.actor)) {
      return skip("blocked-target");
    }
    if (
      post.quotedPost.actor.accountId != null ||
      new URL(post.quotedPost.iri).origin ===
        new URL(txCtx.canonicalOrigin).origin ||
      new URL(post.quotedPost.actor.iri).origin ===
        new URL(txCtx.canonicalOrigin).origin
    ) {
      return skip("local-target");
    }
    const [blockedTargets, blockingTargets] = await Promise.all([
      getBlockedActorIds(db, post.actorId, [post.quotedPost.actorId]),
      getBlockerActorIds(db, post.actorId, [post.quotedPost.actorId]),
    ]);
    if (
      blockedTargets.has(post.quotedPost.actorId) ||
      blockingTargets.has(post.quotedPost.actorId)
    ) {
      return skip("blocked-relationship");
    }
    if (
      post.quotedPost.visibility === "direct" ||
      post.quotedPost.visibility === "none" ||
      post.quotedPost.censored != null
    ) {
      return skip("private-target");
    }
    if (post.type === "Question" && post.poll == null) {
      return skip("missing-poll");
    }
    const pendingRequest = await db.query.quoteRequestTable.findFirst({
      columns: { id: true },
      where: {
        quotePostId: post.id,
        quotedPostId: post.quotedPost.id,
        accepted: { isNull: true },
        rejected: { isNull: true },
      },
    });
    if (pendingRequest != null || post.quoteTargetState === "pending") {
      return skip("already-pending");
    }

    const baseResult = {
      postId: post.id,
      noteSourceId: post.noteSourceId,
      postIri: post.iri,
      quotedPostIri: post.quotedPost.iri,
    };
    if (options.dryRun) return { status: "eligible", ...baseResult };

    const relations = {
      ...(post.replyTarget == null
        ? {}
        : { replyTargetId: new URL(post.replyTarget.iri) }),
      quotedPost: post.quotedPost,
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
    const request = new vocab.QuoteRequest({
      id: requestId,
      actor: txCtx.getActorUri(post.noteSource.accountId),
      object: new URL(post.quotedPost.iri),
      instrument,
    });

    await db
      .update(postTable)
      .set({ quoteTargetState: "pending" })
      .where(
        and(
          eq(postTable.id, post.id),
          eq(postTable.quotedPostId, post.quotedPost.id),
          isNull(postTable.quoteAuthorizationIri),
        ),
      );
    await db.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestId.href,
      quotePostId: post.id,
      quotedPostId: post.quotedPost.id,
    });
    await txCtx.sendActivity(
      { identifier: post.noteSource.accountId },
      {
        id: new URL(post.quotedPost.actor.iri),
        inboxId: new URL(post.quotedPost.actor.inboxUrl),
        endpoints:
          post.quotedPost.actor.sharedInboxUrl == null
            ? null
            : { sharedInbox: new URL(post.quotedPost.actor.sharedInboxUrl) },
      },
      request,
      {
        orderingKey: post.iri,
        preferSharedInbox: true,
      },
    );
    return {
      status: "requested",
      ...baseResult,
      requestIri: requestId.href,
    };
  });
}
