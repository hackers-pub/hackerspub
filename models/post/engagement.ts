import * as vocab from "@fedify/vocab";
import { and, count, eq } from "drizzle-orm";
import { toRecipient } from "../actor.ts";
import type { ApplicationContext } from "../context.ts";
import type { Database, Transaction } from "../db.ts";
import { refreshNewsScores } from "../news.ts";
import {
  type Account,
  type Actor,
  type Mention,
  noteSourceTable,
  type Post,
  postTable,
  quoteAuthorizationTable,
} from "../schema.ts";

type QuoteUpdatePost = Post & {
  actor: Actor;
  quotedPost: (Post & { actor: Actor }) | null;
  replyTarget: Post | null;
  mentions: (Mention & { actor: Actor })[];
};

export async function updateRepliesCount(
  db: Database,
  replyTarget: Post,
  delta: number,
): Promise<number | undefined> {
  const repliesCount = replyTarget.repliesCount + delta;
  const cnt = await db.select({ count: count() })
    .from(postTable)
    .where(eq(postTable.replyTargetId, replyTarget.id));
  if (repliesCount <= cnt[0].count) {
    await db.update(postTable)
      .set({ repliesCount: cnt[0].count })
      .where(eq(postTable.id, replyTarget.id));
    replyTarget.repliesCount = cnt[0].count;
    return cnt[0].count;
  }
  return repliesCount;
}

export async function updateSharesCount(
  db: Database,
  post: Post,
  delta: number,
): Promise<number> {
  const sharesCount = post.sharesCount + delta;
  const cnt = await db.select({ count: count() })
    .from(postTable)
    .where(eq(postTable.sharedPostId, post.id));
  if (sharesCount <= cnt[0].count) {
    await db.update(postTable)
      .set({ sharesCount: cnt[0].count })
      .where(eq(postTable.id, post.id));
    post.sharesCount = cnt[0].count;
    return cnt[0].count;
  }
  return sharesCount;
}

export async function updateQuotesCount(
  db: Database | Transaction,
  post: Post,
  delta: number,
): Promise<number> {
  const quotesCount = post.quotesCount + delta;
  const cnt = await db.select({ count: count() })
    .from(postTable)
    .where(eq(postTable.quotedPostId, post.id));
  if (quotesCount <= cnt[0].count) {
    await db.update(postTable)
      .set({ quotesCount: cnt[0].count })
      .where(eq(postTable.id, post.id));
    post.quotesCount = cnt[0].count;
    return cnt[0].count;
  }
  return quotesCount;
}

export async function revokeQuote(
  fedCtx: ApplicationContext,
  account: Account,
  quotePost: Post & { actor: Actor },
  quotedPost: Post,
): Promise<Post> {
  const { db } = fedCtx;
  const revoked = new Date();
  let updatedQuote: QuoteUpdatePost | undefined;
  const rows = await db.update(postTable)
    .set({
      quotedPostId: null,
      quoteAuthorizationIri: null,
      quoteTargetState: "denied",
      updated: revoked,
    })
    .where(and(
      eq(postTable.id, quotePost.id),
      eq(postTable.quotedPostId, quotedPost.id),
    ))
    .returning();
  const updatedPost = rows[0];
  if (updatedPost == null) {
    return await db.query.postTable.findFirst({
      where: { id: quotePost.id },
    }) ??
      quotePost;
  }
  if (quotePost.actor.accountId != null && quotePost.noteSourceId != null) {
    await db.update(noteSourceTable)
      .set({ updated: revoked })
      .where(eq(noteSourceTable.id, quotePost.noteSourceId));
    updatedQuote = await db.query.postTable.findFirst({
      with: {
        actor: true,
        quotedPost: { with: { actor: true } },
        replyTarget: true,
        mentions: { with: { actor: true } },
      },
      where: { id: quotePost.id },
    });
    if (updatedQuote != null) {
      await sendLocalQuoteUpdate(fedCtx, updatedQuote, null, revoked);
    }
  }
  if (quotePost.quoteAuthorizationIri != null) {
    await db.update(quoteAuthorizationTable)
      .set({ revoked: true, updated: revoked })
      .where(eq(quoteAuthorizationTable.iri, quotePost.quoteAuthorizationIri));
    if (quotePost.actor.accountId == null) {
      const activity = new vocab.Delete({
        id: new URL("#delete", quotePost.quoteAuthorizationIri),
        actor: fedCtx.getActorUri(account.id),
        object: new URL(quotePost.quoteAuthorizationIri),
      });
      await fedCtx.sendActivity(
        { identifier: account.id },
        toRecipient(quotePost.actor),
        activity,
        {
          orderingKey: quotePost.quoteAuthorizationIri,
          excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
        },
      );
    } else if (updatedQuote != null) {
      await sendLocalQuoteAuthorizationDelete(
        fedCtx,
        account,
        updatedQuote,
        quotePost.quoteAuthorizationIri,
      );
    }
  }
  await updateQuotesCount(db, quotedPost, -1);
  // The quoted post lost a public quote, so re-score its link.
  await refreshNewsScores(db, [quotedPost.linkId]);
  return updatedPost;
}

async function sendLocalQuoteAuthorizationDelete(
  fedCtx: ApplicationContext,
  account: Account,
  quote: QuoteUpdatePost,
  quoteAuthorizationIri: string,
): Promise<void> {
  const activity = new vocab.Delete({
    id: new URL("#delete", quoteAuthorizationIri),
    actor: fedCtx.getActorUri(account.id),
    object: new URL(quoteAuthorizationIri),
  });
  const excludeBaseUris = [
    new URL(fedCtx.origin),
    new URL(fedCtx.canonicalOrigin),
  ];
  if (quote.mentions.length > 0) {
    await fedCtx.sendActivity(
      { identifier: account.id },
      quote.mentions.map((mention) => toRecipient(mention.actor)),
      activity,
      {
        orderingKey: quoteAuthorizationIri,
        preferSharedInbox: false,
        excludeBaseUris,
      },
    );
  }
  if (
    quote.visibility !== "public" &&
    quote.visibility !== "unlisted" &&
    quote.visibility !== "followers"
  ) {
    return;
  }
  const followers = await fedCtx.db.query.followingTable.findMany({
    with: { follower: true },
    where: {
      followeeId: quote.actorId,
      accepted: { isNotNull: true },
    },
  });
  if (followers.length < 1) return;
  await fedCtx.sendActivity(
    { identifier: account.id },
    followers.map((following) => toRecipient(following.follower)),
    activity,
    {
      orderingKey: quoteAuthorizationIri,
      preferSharedInbox: true,
      excludeBaseUris,
    },
  );
}

async function sendLocalQuoteUpdate(
  fedCtx: ApplicationContext,
  quote: QuoteUpdatePost,
  quoteAuthorizationIri: string | null,
  updated: Date,
): Promise<void> {
  if (quote.actor.accountId == null || quote.noteSourceId == null) return;
  const noteSource = await fedCtx.db.query.noteSourceTable.findFirst({
    where: { id: quote.noteSourceId },
    with: {
      account: true,
      media: { with: { medium: true }, orderBy: { index: "asc" } },
    },
  });
  if (noteSource == null) return;
  const noteObject = await fedCtx.services.federation.getNote(
    fedCtx,
    noteSource,
    {
      replyTargetId: quote.replyTarget == null
        ? undefined
        : new URL(quote.replyTarget.iri),
      quotedPost: quote.quotedPost ?? undefined,
      quoteAuthorizationIri,
    },
  );
  const update = new vocab.Update({
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
    await fedCtx.sendActivity(
      { identifier: quote.actor.accountId },
      quote.mentions.map((mention) => toRecipient(mention.actor)),
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
  const relayedTags = await fedCtx.services.federation
    .sendTagsPubRelayActivity(
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
    await fedCtx.db.update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, quote.id));
    quote.relayedTags = [...relayedTags];
  }
}
