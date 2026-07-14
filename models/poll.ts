import type { DocumentLoader } from "@fedify/fedify";
import { assertAccountActorNotSuspended } from "./moderation.ts";
import * as vocab from "@fedify/vocab";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getPersistedActor,
  isCachedActorFederationBlocked,
  isFederationBlocked,
  persistActor,
  toRecipient,
} from "./actor.ts";
import type { ApplicationContext } from "./context.ts";
import { toDate } from "./date.ts";
import type { Database, Transaction } from "./db.ts";
import { createPollEndedNotification } from "./notification.ts";
import { getPersistedPost } from "./post/core.ts";
import { persistPost } from "./post/remote.ts";
import { isPostVisibleTo } from "./post/visibility.ts";
import {
  type Account,
  type Actor,
  actorTable,
  type NewPoll,
  type NewPollOption,
  type NewPollVote,
  type Poll,
  type PollOption,
  pollOptionTable,
  pollTable,
  type PollVote,
  pollVoteTable,
  postTable,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 20;
export const MAX_POLL_TITLE_LENGTH = 200;
export const MAX_POLL_OPTION_TITLE_LENGTH = 200;
export const MIN_POLL_DURATION_MS = 60_000;
export const MAX_POLL_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
export const DEFAULT_ENDED_POLL_NOTIFICATION_BATCH_SIZE = 100;

export interface CreatePollInput {
  multiple: boolean;
  title: string;
  options: readonly string[];
  ends: Date;
  now?: Date;
}

export interface NormalizedPollInput {
  multiple: boolean;
  title: string;
  options: string[];
  ends: Date;
}

export class InvalidPollInputError extends Error {
  constructor(readonly inputPath: string) {
    super(`Invalid poll input: ${inputPath}`);
    this.name = "InvalidPollInputError";
  }
}

export function normalizePollInput(
  input: CreatePollInput,
): NormalizedPollInput {
  const title = input.title.trim();
  if (title.length < 1 || title.length > MAX_POLL_TITLE_LENGTH) {
    throw new InvalidPollInputError("poll.title");
  }

  if (
    input.options.length < MIN_POLL_OPTIONS ||
    input.options.length > MAX_POLL_OPTIONS
  ) {
    throw new InvalidPollInputError("poll.options");
  }

  const options = input.options.map((option) => option.trim());
  const seenOptions = new Set<string>();
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (
      option.length < 1 ||
      option.length > MAX_POLL_OPTION_TITLE_LENGTH
    ) {
      throw new InvalidPollInputError(`poll.options.${i}`);
    }
    if (seenOptions.has(option)) {
      throw new InvalidPollInputError(`poll.options.${i}`);
    }
    seenOptions.add(option);
  }

  const now = input.now ?? new Date();
  const duration = input.ends.getTime() - now.getTime();
  if (
    !Number.isFinite(input.ends.getTime()) ||
    duration < MIN_POLL_DURATION_MS ||
    duration > MAX_POLL_DURATION_MS
  ) {
    throw new InvalidPollInputError("poll.ends");
  }

  return {
    multiple: input.multiple,
    title,
    options,
    ends: input.ends,
  };
}

export async function createPoll(
  db: Database,
  postId: Uuid,
  input: CreatePollInput,
): Promise<Poll & { options: PollOption[] }> {
  const poll = normalizePollInput(input);
  const rows = await db.insert(pollTable).values({
    postId,
    multiple: poll.multiple,
    votersCount: 0,
    ends: poll.ends,
  }).returning();
  if (rows.length < 1) {
    throw new Error("Failed to create poll.");
  }
  const optionRows = await db.insert(pollOptionTable).values(
    poll.options.map((title, index) => ({
      postId,
      index,
      title,
      votesCount: 0,
    })),
  ).returning();
  return {
    ...rows[0],
    options: optionRows.toSorted((a, b) => a.index - b.index),
  };
}

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

export interface PersistPollVoteResult {
  attempted: boolean;
  vote?: PollVote;
}

export async function persistPollVote(
  ctx: ApplicationContext,
  note: vocab.Note,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<PollVote | undefined> {
  return (await persistPollVoteResult(ctx, note, options)).vote;
}

export async function persistPollVoteResult(
  ctx: ApplicationContext,
  note: vocab.Note,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  } = {},
): Promise<PersistPollVoteResult> {
  if (
    note.replyTargetId == null || note.attributionId == null ||
    note.name == null
  ) {
    return { attempted: false };
  }
  const voteName = note.name.toString();
  const hasReplyContent = note.content != null &&
    note.content.toString().trim() !== "";
  const { db } = ctx;
  // Check the cached voter first, before any remote dereference or
  // Question persistence a federation-blocked actor could trigger.
  if (await isCachedActorFederationBlocked(db, note.attributionId)) {
    return { attempted: true };
  }
  let post = await getPersistedPost(db, note.replyTargetId);
  let persistedRemotePollWithVotersCount = false;
  let persistedRemotePollWithOptionVotesCount = false;
  let targetIsQuestion = post?.type === "Question";
  if (post == null) {
    const question = await note.getReplyTarget(options);
    if (!(question instanceof vocab.Question)) return { attempted: false };
    targetIsQuestion = true;
    // A newly fetched remote Question may already include this vote in its
    // aggregate counts, so preserve those counts instead of incrementing them
    // again after inserting the local vote row.
    persistedRemotePollWithVotersCount = question.voters != null;
    persistedRemotePollWithOptionVotesCount = await hasRemoteOptionVotesCount(
      question,
      voteName,
    );
    post = await persistPost(ctx, question, options);
    if (post == null) return { attempted: true };
  }
  let actor = await getPersistedActor(db, note.attributionId);
  if (actor == null) {
    const actorObject = await note.getAttribution(options);
    if (actorObject == null) return { attempted: true };
    actor = await persistActor(ctx, actorObject, options);
    if (actor == null) return { attempted: true };
  }
  if (isFederationBlocked(actor)) return { attempted: true };
  const persistVoteInTransaction = async (tx: Transaction) => {
    const [lockedPoll] = await tx.select()
      .from(pollTable)
      .where(eq(pollTable.postId, post.id))
      .for("update");
    if (lockedPoll == null) {
      return { attempted: targetIsQuestion && !hasReplyContent };
    }
    const visiblePost = await tx.query.postTable.findFirst({
      where: { id: lockedPoll.postId },
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
    });
    if (visiblePost == null || !isPostVisibleTo(visiblePost, actor)) {
      return { attempted: true };
    }

    const pollOptions = await tx.query.pollOptionTable.findMany({
      where: { postId: lockedPoll.postId },
    });
    const option = pollOptions.find((o) => o.title === voteName);
    if (option == null) return { attempted: !hasReplyContent };
    if (lockedPoll.ends <= new Date()) return { attempted: true };

    const existingVotes = await tx.query.pollVoteTable.findMany({
      where: {
        postId: lockedPoll.postId,
        actorId: actor.id,
      },
    });
    if (!lockedPoll.multiple && existingVotes.length > 0) {
      return { attempted: true };
    }

    const rows = await tx.insert(pollVoteTable)
      .values({
        postId: lockedPoll.postId,
        actorId: actor.id,
        optionIndex: option.index,
      })
      .onConflictDoNothing()
      .returning();
    if (rows.length < 1) return { attempted: true };

    if (
      existingVotes.length < 1 && !persistedRemotePollWithVotersCount
    ) {
      await tx.update(pollTable)
        .set({ votersCount: sql`${pollTable.votersCount} + 1` })
        .where(eq(pollTable.postId, lockedPoll.postId));
    }
    if (!persistedRemotePollWithOptionVotesCount) {
      await tx.update(pollOptionTable)
        .set({ votesCount: sql`${pollOptionTable.votesCount} + 1` })
        .where(
          and(
            eq(pollOptionTable.postId, lockedPoll.postId),
            eq(pollOptionTable.index, option.index),
          ),
        );
    }
    return { attempted: true, vote: rows[0] };
  };

  return isTransaction(db)
    ? await persistVoteInTransaction(db)
    : await db.transaction(persistVoteInTransaction);
}

async function hasRemoteOptionVotesCount(
  question: vocab.Question,
  voteName: string,
): Promise<boolean> {
  let hasInclusiveOptions = false;
  for await (const option of question.getInclusiveOptions()) {
    hasInclusiveOptions = true;
    const title = option.name?.toString();
    if (title === voteName) {
      const replies = await option.getReplies();
      return replies?.totalItems != null;
    }
  }
  if (hasInclusiveOptions) return false;
  for await (const option of question.getExclusiveOptions()) {
    const title = option.name?.toString();
    if (title === voteName) {
      const replies = await option.getReplies();
      return replies?.totalItems != null;
    }
  }
  return false;
}

function returnedRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result != null && typeof result === "object" &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  throw new TypeError("Unexpected execute result shape.");
}

export interface NotifyEndedPollsOptions {
  now?: Date;
  maxPolls?: number;
}

export interface NotifyEndedPollsResult {
  pollsProcessed: number;
  notificationsCreated: number;
}

export async function notifyEndedPolls(
  db: Database,
  options: NotifyEndedPollsOptions = {},
): Promise<NotifyEndedPollsResult> {
  const now = options.now ?? new Date();
  const maxPolls = options.maxPolls ??
    DEFAULT_ENDED_POLL_NOTIFICATION_BATCH_SIZE;
  if (!Number.isInteger(maxPolls) || maxPolls < 1) {
    return { pollsProcessed: 0, notificationsCreated: 0 };
  }

  const notifyInTransaction = async (tx: Transaction) => {
    const postIds = await claimEndedPolls(tx, now, maxPolls);
    return await notifyClaimedEndedPolls(tx, postIds);
  };
  return isTransaction(db)
    ? await notifyInTransaction(db)
    : await db.transaction(notifyInTransaction);
}

async function claimEndedPolls(
  tx: Transaction,
  now: Date,
  maxPolls: number,
): Promise<Uuid[]> {
  const result = await tx.execute(sql`
    UPDATE poll
    SET ended_notifications_sent = ${now.toISOString()}::timestamptz
    WHERE post_id IN (
      SELECT poll.post_id
      FROM poll
      WHERE poll.ended_notifications_sent IS NULL
        AND poll.ends <= ${now.toISOString()}::timestamptz
      ORDER BY poll.ends ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${maxPolls}
    )
    RETURNING post_id
  `);
  const claimed = returnedRows<{ post_id: Uuid }>(result);
  return claimed.map((row) => row.post_id);
}

async function notifyClaimedEndedPolls(
  db: Database,
  postIds: Uuid[],
): Promise<NotifyEndedPollsResult> {
  if (postIds.length < 1) {
    return { pollsProcessed: 0, notificationsCreated: 0 };
  }

  const polls = await db.select({
    postId: pollTable.postId,
    ends: pollTable.ends,
    post: postTable,
    author: actorTable,
  })
    .from(pollTable)
    .innerJoin(postTable, eq(postTable.id, pollTable.postId))
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .where(inArray(pollTable.postId, postIds));
  const votes = await db.select({
    postId: pollVoteTable.postId,
    accountId: actorTable.accountId,
  })
    .from(pollVoteTable)
    .innerJoin(actorTable, eq(actorTable.id, pollVoteTable.actorId))
    .where(inArray(pollVoteTable.postId, postIds));

  const votersByPostId = new Map<Uuid, Set<Uuid>>();
  for (const vote of votes) {
    if (vote.accountId == null) continue;
    let voters = votersByPostId.get(vote.postId);
    if (voters == null) {
      voters = new Set();
      votersByPostId.set(vote.postId, voters);
    }
    voters.add(vote.accountId);
  }

  let notificationsCreated = 0;
  for (const poll of polls) {
    const author = poll.author;
    const recipientAccountIds = new Set<Uuid>();
    if (author.accountId != null) recipientAccountIds.add(author.accountId);
    const voterAccountIds = votersByPostId.get(poll.postId);
    if (voterAccountIds != null) {
      for (const accountId of voterAccountIds) {
        recipientAccountIds.add(accountId);
      }
    }
    for (const accountId of recipientAccountIds) {
      const notification = await createPollEndedNotification(
        db,
        accountId,
        poll.post,
        author,
        poll.ends,
      );
      if (notification != null) notificationsCreated++;
    }
  }

  return { pollsProcessed: postIds.length, notificationsCreated };
}

export async function vote(
  fedCtx: ApplicationContext,
  voter: Account & { actor: Actor },
  poll: Poll & { options: PollOption[] },
  optionIndices: Set<number>,
): Promise<PollVote[]> {
  const { db } = fedCtx;
  await assertAccountActorNotSuspended(db, voter.id);
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
