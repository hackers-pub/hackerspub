import type { Context, DocumentLoader } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getPersistedActor, persistActor, toRecipient } from "./actor.ts";
import type { ContextData } from "./context.ts";
import { toDate } from "./date.ts";
import type { Database, Transaction } from "./db.ts";
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
  const endTime = question.endTime ??
    (question.closed instanceof Temporal.Instant ? question.closed : null);
  if (endTime == null) return undefined;
  let multiple = true;
  let options = await Array.fromAsync(question.getInclusiveOptions());
  if (options.length < 1) {
    options = await Array.fromAsync(question.getExclusiveOptions());
    multiple = false;
  }
  const seenOptionTitles = new Set<string>();
  options = options.filter((option) => {
    const title = option.name?.toString();
    if (title == null) return true;
    if (seenOptionTitles.has(title)) return false;
    seenOptionTitles.add(title);
    return true;
  });
  if (options.length < 1) return undefined;
  const ends = toDate(endTime);
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

  // Collect new option titles mapped to their target indices so we can detect
  // options that were removed or whose index shifted (reordered).
  const newOptionTitles = new Map<string, number>();
  let i = 0;
  for (const option of options) {
    const title = option.name?.toString();
    if (title != null) newOptionTitles.set(title, i);
    i++;
  }

  // Remove options that no longer exist or that moved to a different index.
  // Votes must be deleted first because the FK from poll_vote to poll_option
  // has no ON DELETE CASCADE.
  const existingOptions = await db.query.pollOptionTable.findMany({
    where: { postId },
  });
  for (const existing of existingOptions) {
    const newIndex = newOptionTitles.get(existing.title);
    if (newIndex == null || newIndex !== existing.index) {
      await db.delete(pollVoteTable).where(
        and(
          eq(pollVoteTable.postId, postId),
          eq(pollVoteTable.optionIndex, existing.index),
        ),
      );
      await db.delete(pollOptionTable).where(
        and(
          eq(pollOptionTable.postId, postId),
          eq(pollOptionTable.index, existing.index),
        ),
      );
    }
  }

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
  const { db } = fedCtx.data;
  const voteInTransaction = async (tx: Transaction) => {
    if (
      optionIndices.size < 1 ||
      !poll.multiple && optionIndices.size > 1
    ) {
      return { post: undefined, votes: [], federate: false };
    }

    const [lockedPoll] = await tx
      .select({ postId: pollTable.postId })
      .from(pollTable)
      .where(
        and(
          eq(pollTable.postId, poll.postId),
          sql`${pollTable.ends} > now()`,
        ),
      )
      .for("update");
    if (lockedPoll == null) {
      return { post: undefined, votes: [], federate: false };
    }

    const post = await tx.query.postTable.findFirst({
      where: { id: poll.postId },
      with: {
        actor: true,
      },
    });
    if (post?.type !== "Question") {
      return { post, votes: [], federate: false };
    }

    const alreadyVoted = await tx.query.pollVoteTable.findMany({
      where: { postId: poll.postId, actorId: voter.actor.id },
    });
    if (alreadyVoted.length > 0) {
      return { post, votes: alreadyVoted, federate: false };
    }

    const indices = [...optionIndices].filter((index) =>
      poll.options.find((o) => o.index === index) != null
    );
    if (indices.length < 1) return { post, votes: [], federate: false };

    const votes = await tx.insert(pollVoteTable)
      .values(indices.map((index) => ({
        postId: poll.postId,
        actorId: voter.actor.id,
        optionIndex: index,
      } satisfies NewPollVote)))
      .returning();
    await tx.update(pollTable)
      .set({ votersCount: sql`${pollTable.votersCount} + 1` })
      .where(eq(pollTable.postId, poll.postId));
    await tx.update(pollOptionTable)
      .set({ votesCount: sql`${pollOptionTable.votesCount} + 1` })
      .where(
        and(
          eq(pollOptionTable.postId, poll.postId),
          inArray(pollOptionTable.index, indices),
        ),
      );

    return { post, votes, federate: true };
  };

  const { post, votes, federate } = isTransaction(db)
    ? await voteInTransaction(db)
    : await db.transaction(voteInTransaction);

  if (federate && post != null && post.actor.accountId == null) {
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

function isTransaction(db: Database): db is Transaction {
  return "rollback" in db;
}
