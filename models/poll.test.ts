import assert from "node:assert/strict";
import test from "node:test";
import * as vocab from "@fedify/vocab";
import type { Transaction } from "./db.ts";
import { persistPollVote, vote } from "./poll.ts";
import {
  type NewPost,
  type Poll,
  type PollOption,
  pollOptionTable,
  pollTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

type InsertQuestionPollResult = {
  post: NonNullable<
    Awaited<ReturnType<Transaction["query"]["postTable"]["findFirst"]>>
  >;
  poll: Poll & { options: PollOption[] };
};

async function insertQuestionPoll(
  tx: Transaction,
  values: {
    account: Awaited<ReturnType<typeof insertAccountWithActor>>["account"];
    multiple: boolean;
    optionTitles: string[];
    ends?: Date;
  },
): Promise<InsertQuestionPollResult> {
  const postId = generateUuidV7();
  const published = new Date("2026-04-15T00:00:00.000Z");

  await tx.insert(postTable).values(
    {
      id: postId,
      iri: `http://localhost/objects/${postId}`,
      type: "Question",
      visibility: "public",
      actorId: values.account.actor.id,
      name: "Poll question",
      contentHtml: "<p>Poll question</p>",
      language: "en",
      tags: {},
      emojis: {},
      url: `http://localhost/@${values.account.username}/polls/${postId}`,
      published,
      updated: published,
    } satisfies NewPost,
  );

  const post = await tx.query.postTable.findFirst({ where: { id: postId } });
  assert.ok(post != null);

  await tx.insert(pollTable).values({
    postId: post.id,
    multiple: values.multiple,
    votersCount: 0,
    ends: values.ends ?? new Date("2026-04-16T00:00:00.000Z"),
  });
  await tx.insert(pollOptionTable).values(
    values.optionTitles.map((title, index) => ({
      postId: post.id,
      index,
      title,
      votesCount: 0,
    })),
  );

  const poll = await tx.query.pollTable.findFirst({
    where: { postId: post.id },
    with: { options: true },
  });
  assert.ok(poll != null);

  return { post, poll };
}

test("vote() stores a single-choice vote and stays idempotent", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "pollauthor",
      name: "Poll Author",
      email: "pollauthor@example.com",
    });
    const voter = await insertAccountWithActor(tx, {
      username: "pollvoter",
      name: "Poll Voter",
      email: "pollvoter@example.com",
    });
    const { poll } = await insertQuestionPoll(tx, {
      account: author.account,
      multiple: false,
      optionTitles: ["TypeScript", "Rust"],
    });

    const firstVote = await vote(fedCtx, voter.account, poll, new Set([1]));

    assert.equal(firstVote.length, 1);
    assert.equal(firstVote[0].optionIndex, 1);

    const storedPoll = await tx.query.pollTable.findFirst({
      where: { postId: poll.postId },
    });
    assert.ok(storedPoll != null);
    assert.equal(storedPoll.votersCount, 1);

    const storedOptions = await tx.query.pollOptionTable.findMany({
      where: { postId: poll.postId },
      orderBy: { index: "asc" },
    });
    assert.deepEqual(
      storedOptions.map((option) => option.votesCount),
      [0, 1],
    );

    const repeatedVote = await vote(fedCtx, voter.account, poll, new Set([0]));

    assert.equal(repeatedVote.length, 1);
    assert.equal(repeatedVote[0].optionIndex, 1);

    const pollAfterRepeat = await tx.query.pollTable.findFirst({
      where: { postId: poll.postId },
    });
    assert.ok(pollAfterRepeat != null);
    assert.equal(pollAfterRepeat.votersCount, 1);
  });
});

test("vote() rejects multiple choices for single polls and allows them for multi polls", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "multiauthor",
      name: "Multi Author",
      email: "multiauthor@example.com",
    });
    const singleVoter = await insertAccountWithActor(tx, {
      username: "singlevoter",
      name: "Single Voter",
      email: "singlevoter@example.com",
    });
    const multiVoter = await insertAccountWithActor(tx, {
      username: "multivoter",
      name: "Multi Voter",
      email: "multivoter@example.com",
    });
    const { poll: singlePoll } = await insertQuestionPoll(tx, {
      account: author.account,
      multiple: false,
      optionTitles: ["One", "Two"],
    });
    const { poll: multiPoll } = await insertQuestionPoll(tx, {
      account: author.account,
      multiple: true,
      optionTitles: ["Red", "Blue", "Green"],
    });

    const rejected = await vote(
      fedCtx,
      singleVoter.account,
      singlePoll,
      new Set([0, 1]),
    );
    assert.deepEqual(rejected, []);

    const accepted = await vote(
      fedCtx,
      multiVoter.account,
      multiPoll,
      new Set([0, 2]),
    );
    assert.equal(accepted.length, 2);
    assert.deepEqual(
      accepted.map((entry) => entry.optionIndex).sort((a, b) => a - b),
      [0, 2],
    );

    const storedMultiPoll = await tx.query.pollTable.findFirst({
      where: { postId: multiPoll.postId },
    });
    assert.ok(storedMultiPoll != null);
    assert.equal(storedMultiPoll.votersCount, 1);

    const multiOptions = await tx.query.pollOptionTable.findMany({
      where: { postId: multiPoll.postId },
      orderBy: { index: "asc" },
    });
    assert.deepEqual(
      multiOptions.map((option) => option.votesCount),
      [1, 0, 1],
    );
  });
});

test("persistPollVote() stores an incoming vote for a persisted poll", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "persistpollauthor",
      name: "Persist Poll Author",
      email: "persistpollauthor@example.com",
    });
    const remoteVoter = await insertRemoteActor(tx, {
      username: "persistpollvoter",
      name: "Persist Poll Voter",
      host: "remote.example",
      iri: "https://remote.example/users/persistpollvoter",
    });
    const { poll, post } = await insertQuestionPoll(tx, {
      account: author.account,
      multiple: false,
      optionTitles: ["TypeScript", "Rust"],
    });

    const voteNote = new vocab.Note({
      id: new URL(`http://localhost/objects/${generateUuidV7()}`),
      attribution: new URL(remoteVoter.iri),
      name: "Rust",
      replyTarget: new URL(post.iri),
    });

    const storedVote = await persistPollVote(fedCtx, voteNote);

    assert.ok(storedVote != null);
    assert.equal(storedVote.postId, poll.postId);
    assert.equal(storedVote.actorId, remoteVoter.id);
    assert.equal(storedVote.optionIndex, 1);

    const votes = await tx.query.pollVoteTable.findMany({
      where: { postId: poll.postId },
    });
    assert.equal(votes.length, 1);
    assert.equal(votes[0].actorId, remoteVoter.id);
    assert.equal(votes[0].optionIndex, 1);
  });
});
