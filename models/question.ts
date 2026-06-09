import type { Context } from "@fedify/fedify";
import type { Recipient } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { getQuestion } from "@hackerspub/federation/objects";
import { sendTagsPubRelayActivity } from "@hackerspub/federation/tags-pub";
import { eq, sql } from "drizzle-orm";
import {
  createMentionNotification,
  createQuoteNotification,
  createReplyNotification,
} from "./notification.ts";
import {
  createNoteSource,
  createNoteSourceMedium,
  type NoteSourceMediumWithMedium,
  QuotePolicyDeniedError,
} from "./note.ts";
import { type CreatePollInput, normalizePollInput } from "./poll.ts";
import {
  getAllowedQuoteTargetForActor,
  syncPostFromNoteSource,
  updateRepliesCount,
} from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type Instance,
  type Mention,
  type NewNoteSource,
  type NoteSource,
  noteSourceTable,
  type Poll,
  type PollOption,
  type Post,
  type PostMedium,
  postTable,
  quoteRequestTable,
} from "./schema.ts";
import { syncActorFromAccount } from "./actor.ts";
import type { ContextData } from "./context.ts";
import type { Transaction } from "./db.ts";
import { addPostToTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

export interface CreateQuestionPollInput extends CreatePollInput {
  title: string;
}

export async function createQuestion(
  fedCtx: Context<ContextData<Transaction>>,
  source: Omit<NewNoteSource, "id"> & {
    id?: Uuid;
    media: ({ blob: Blob; alt: string } | { mediumId: Uuid; alt: string })[];
    poll: CreateQuestionPollInput;
  },
  relations: {
    replyTarget?: Post & { actor: Actor };
    quotedPost?: Post & { actor: Actor };
  } = {},
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      media: NoteSourceMediumWithMedium[];
    };
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    poll: Poll & { options: PollOption[] };
  } | undefined
> {
  const normalizedPoll = normalizePollInput(source.poll);
  const { db, disk } = fedCtx.data;
  const account = await db.query.accountTable.findFirst({
    where: { id: source.accountId },
    with: { avatarMedium: true, emails: true, links: true },
  });
  if (account == null) return undefined;
  if (relations.quotedPost != null) {
    const actor = await syncActorFromAccount(fedCtx, account);
    const allowedQuoteTarget = await getAllowedQuoteTargetForActor(
      db,
      actor,
      relations.quotedPost,
    );
    if (allowedQuoteTarget == null) throw new QuotePolicyDeniedError();
  }

  const noteSource = await createNoteSource(db, source);
  if (noteSource == null) return undefined;

  let index = 0;
  const media: NoteSourceMediumWithMedium[] = [];
  for (const medium of source.media) {
    const m = await createNoteSourceMedium(
      db,
      disk,
      noteSource.id,
      index,
      medium,
    );
    if (m == null) {
      await db.delete(noteSourceTable).where(
        eq(noteSourceTable.id, noteSource.id),
      );
      return undefined;
    }
    media.push(m);
    index++;
  }

  const post = await syncPostFromNoteSource(fedCtx, {
    ...noteSource,
    media,
    account,
  }, {
    ...relations,
    question: {
      title: normalizedPoll.title,
      poll: {
        ...normalizedPoll,
        now: source.poll.now,
      },
    },
  });
  if (post == null || post.poll == null) {
    if (relations.quotedPost != null) throw new QuotePolicyDeniedError();
    throw new Error("Failed to persist question post.");
  }

  if (relations.replyTarget != null) {
    await updateRepliesCount(db, relations.replyTarget, 1);
  }
  await addPostToTimeline(db, post);

  const questionObject = await getQuestion(
    fedCtx,
    { ...noteSource, media, account },
    { ...post.poll, post, options: post.poll.options },
    {
      replyTargetId: relations.replyTarget == null
        ? undefined
        : new URL(relations.replyTarget.iri),
      quotedPost: post.quoteRequestRequired
        ? undefined
        : post.quotedPost ?? undefined,
      quoteAuthorizationIri: post.quoteAuthorizationIri,
      quoteRequestPolicy: post.quoteRequestPolicy,
    },
  );
  const activity = new vocab.Create({
    id: new URL("#create", questionObject.id ?? fedCtx.origin),
    actors: questionObject.attributionIds,
    tos: questionObject.toIds,
    ccs: questionObject.ccIds,
    object: questionObject,
  });
  const orderingKey = post.iri;
  const quoteRequestTarget = post.quoteRequestTarget;
  if (post.quoteRequestRequired && quoteRequestTarget != null) {
    const requestId = new URL(
      "#quote-request",
      questionObject.id ?? fedCtx.origin,
    );
    const instrument = await getQuestion(
      fedCtx,
      { ...noteSource, media, account },
      { ...post.poll, post, options: post.poll.options },
      {
        replyTargetId: relations.replyTarget == null
          ? undefined
          : new URL(relations.replyTarget.iri),
        quotedPost: quoteRequestTarget,
        quoteRequestPolicy: post.quoteRequestPolicy,
      },
    );
    const request = new vocab.QuoteRequest({
      id: requestId,
      actor: fedCtx.getActorUri(source.accountId),
      object: new URL(quoteRequestTarget.iri),
      instrument,
    });
    await db.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestId.href,
      quotePostId: post.id,
      quotedPostId: quoteRequestTarget.id,
    }).onConflictDoUpdate({
      target: quoteRequestTable.iri,
      set: {
        quotePostId: post.id,
        quotedPostId: quoteRequestTarget.id,
        accepted: null,
        rejected: null,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    });
    await fedCtx.sendActivity(
      { identifier: source.accountId },
      {
        id: new URL(quoteRequestTarget.actor.iri),
        inboxId: new URL(quoteRequestTarget.actor.inboxUrl),
        endpoints: quoteRequestTarget.actor.sharedInboxUrl == null
          ? null
          : { sharedInbox: new URL(quoteRequestTarget.actor.sharedInboxUrl) },
      },
      request,
      {
        orderingKey,
        preferSharedInbox: true,
      },
    );
  }
  if (post.mentions.length > 0) {
    const directRecipients: Recipient[] = post.mentions.map((m) => ({
      id: new URL(m.actor.iri),
      inboxId: new URL(m.actor.inboxUrl),
      endpoints: m.actor.sharedInboxUrl == null
        ? null
        : { sharedInbox: new URL(m.actor.sharedInboxUrl) },
    }));
    await fedCtx.sendActivity(
      { identifier: source.accountId },
      directRecipients,
      activity,
      {
        orderingKey,
        preferSharedInbox: false,
        excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
      },
    );
  }
  if (post.visibility !== "direct") {
    await fedCtx.sendActivity(
      { identifier: source.accountId },
      "followers",
      activity,
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
      },
    );
  }
  const relayedTags = await sendTagsPubRelayActivity(
    fedCtx,
    source.accountId,
    activity,
    {
      orderingKey,
      visibility: post.visibility,
      accountBio: account.bio,
    },
  );
  if (relayedTags != null) {
    await db.update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, post.id));
    post.relayedTags = [...relayedTags];
  }

  if (
    post.replyTarget != null && post.replyTarget.actor.accountId != null &&
    post.replyTarget.actorId !== post.actorId
  ) {
    await createReplyNotification(
      db,
      post.replyTarget.actor.accountId,
      post,
      post.actor,
    );
  }
  if (
    post.quotedPost != null && post.quotedPost.actor.accountId != null &&
    post.quotedPost.actorId !== post.actorId
  ) {
    await createQuoteNotification(
      db,
      post.quotedPost.actor.accountId,
      post,
      post.actor,
    );
  }
  for (const mention of post.mentions) {
    if (mention.actor.accountId == null) continue;
    if (post.replyTarget?.actorId === mention.actorId) continue;
    if (post.quotedPost?.actorId === mention.actorId) continue;
    if (mention.actorId === post.actorId) continue;
    await createMentionNotification(
      db,
      mention.actor.accountId,
      post,
      post.actor,
    );
  }

  return {
    ...post,
    poll: { ...post.poll, options: post.poll.options },
  };
}
