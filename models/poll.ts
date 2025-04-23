import type { Context, DocumentLoader } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getPersistedActor, persistActor, toRecipient } from "./actor.ts";
import type { ContextData } from "./context.ts";
import { toDate } from "./date.ts";
import type { Database } from "./db.ts";
import { getPersistedPost, persistPost } from "./post.ts";
import {
  type Account,
  type Actor,
  type NewPoll,
  type NewPollOption,
  type NewPollVote,
  type Poll,
  type PollOption,
  pollOptionTable,
  pollTable,
  type PollVote,
  pollVoteTable,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export async function persistPoll(
  db: Database,
  question: vocab.Question,
  postId: Uuid,
): Promise<Poll | undefined> {
  if (question.endTime == null) return undefined;
  let multiple = true;
  let options = await Array.fromAsync(question.getInclusiveOptions());
  if (options.length < 1) {
    options = await Array.fromAsync(question.getExclusiveOptions());
    multiple = false;
  }
  if (options.length < 1) return undefined;
  const ends = toDate(question.endTime);
  if (ends == null) return undefined;
  const values: NewPoll = {
    postId,
    multiple,
    votersCount: question.voters ?? 0,
    ends,
  };
  const rows = await db.insert(pollTable)
    .values(values)
    .onConflictDoUpdate({
      target: pollTable.postId,
      set: values,
    })
    .returning();
  if (rows.length < 1) return undefined;
  let index = 0;
  for (const option of options) {
    await persistPollOption(db, option, postId, index);
    index++;
  }
  return rows[0];
}

export async function persistPollOption(
  db: Database,
  object: vocab.Object,
  postId: Uuid,
  index: number,
): Promise<PollOption | undefined> {
  const title = object.name?.toString();
  if (title == null) return undefined;
  const replies = await object.getReplies();
  const values: NewPollOption = {
    postId,
    index,
    title,
    votesCount: replies?.totalItems ?? undefined,
  };
  const rows = await db.insert(pollOptionTable)
    .values(values)
    .onConflictDoUpdate({
      target: [pollOptionTable.postId, pollOptionTable.index],
      set: values,
    })
    .returning();
  return rows.length < 1 ? undefined : rows[0];
}

export async function persistPollVote(
  ctx: Context<ContextData>,
  note: vocab.Note,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<PollVote | undefined> {
  if (
    note.replyTargetId == null || note.attributionId == null ||
    note.name == null
  ) {
    return undefined;
  }
  const { db } = ctx.data;
  let post = await getPersistedPost(db, note.replyTargetId);
  if (post == null) {
    const question = await note.getReplyTarget(options);
    if (!(question instanceof vocab.Question)) return undefined;
    post = await persistPost(ctx, question, options);
    if (post == null) return undefined;
  }
  let actor = await getPersistedActor(db, note.attributionId);
  if (actor == null) {
    const actorObject = await note.getAttribution(options);
    if (actorObject == null) return undefined;
    actor = await persistActor(ctx, actorObject, options);
    if (actor == null) return undefined;
  }
  const poll = await db.query.pollTable.findFirst({
    where: { postId: post.id },
    with: { options: true },
  });
  if (poll == null || poll.ends < new Date()) return undefined;
  if (!poll.multiple) {
    const existingVote = await db.query.pollVoteTable.findFirst({
      where: {
        postId: poll.postId,
        actorId: actor.id,
      },
    });
    if (existingVote != null) return undefined;
  }
  const name = note.name.toString();
  const option = poll.options.find((o) => o.title === name);
  if (option == null) return undefined;
  const rows = await db.insert(pollVoteTable)
    .values({
      postId: poll.postId,
      actorId: actor.id,
      optionIndex: option.index,
    })
    .onConflictDoNothing()
    .returning();
  return rows.length < 1 ? undefined : rows[0];
}

export async function vote(
  fedCtx: Context<ContextData>,
  voter: Account & { actor: Actor },
  poll: Poll & { options: PollOption[] },
  optionIndices: Set<number>,
): Promise<PollVote[]> {
  if (
    poll.ends < new Date() || optionIndices.size < 1 ||
    !poll.multiple && optionIndices.size > 1
  ) {
    return [];
  }
  const { db } = fedCtx.data;
  const post = await db.query.postTable.findFirst({
    where: { id: poll.postId },
    with: {
      actor: true,
    },
  });
  if (post?.type !== "Question") return [];
  const alreadyVoted = await db.query.pollVoteTable.findMany({
    where: { postId: poll.postId, actorId: voter.actor.id },
  });
  if (alreadyVoted.length > 0) return alreadyVoted;
  const indices = [...optionIndices].filter((index) =>
    poll.options.find((o) => o.index === index) != null
  );
  if (indices.length < 1) return [];
  const votes = await db.insert(pollVoteTable)
    .values(indices.map((index) => ({
      postId: poll.postId,
      actorId: voter.actor.id,
      optionIndex: index,
    } satisfies NewPollVote)))
    .returning();
  await db.update(pollTable)
    .set({ votersCount: sql`${pollTable.votersCount} + 1` })
    .where(eq(pollTable.postId, poll.postId));
  await db.update(pollOptionTable)
    .set({ votesCount: sql`${pollOptionTable.votesCount} + 1` })
    .where(
      and(
        eq(pollOptionTable.postId, poll.postId),
        inArray(pollOptionTable.index, indices),
      ),
    );
  if (post.actor.accountId == null) {
    for (const vote of votes) {
      const name = poll.options.find((o) => o.index === vote.optionIndex)
        ?.title;
      if (name == null) continue;
      await fedCtx.sendActivity(
        { identifier: voter.id },
        toRecipient(post.actor),
        new vocab.Create({
          id: new URL(
            `#votes/${vote.postId}/${vote.optionIndex}/activity`,
            fedCtx.getActorUri(voter.id),
          ),
          actor: fedCtx.getActorUri(voter.id),
          to: new URL(post.actor.iri),
          object: new vocab.Note({
            id: new URL(
              `#votes/${vote.postId}/${vote.optionIndex}`,
              fedCtx.getActorUri(voter.id),
            ),
            attribution: fedCtx.getActorUri(voter.id),
            to: new URL(post.actor.iri),
            name,
            replyTarget: new URL(post.iri),
          }),
        }),
      );
    }
  }
  return votes;
}
