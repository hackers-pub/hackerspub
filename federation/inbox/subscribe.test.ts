import assert from "node:assert";
import test from "node:test";
import type { InboxContext } from "@fedify/fedify";
import { Create, Note } from "@fedify/vocab";
import type { Add, Remove } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import {
  type NewPost,
  pollOptionTable,
  pollTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../../test/postgres.ts";
import { onPostPinned, onPostUnpinned } from "./subscribe.ts";
import { onPostCreated } from "./subscribe.ts";

async function insertQuestionPoll(
  tx: Transaction,
  values: {
    account: Awaited<ReturnType<typeof insertAccountWithActor>>["account"];
    optionTitles: string[];
  },
) {
  const postId = generateUuidV7();
  const published = new Date();
  await tx.insert(postTable).values(
    {
      id: postId,
      iri: `http://localhost/objects/${postId}`,
      type: "Question",
      visibility: "public",
      actorId: values.account.actor.id,
      name: "Runtime choice",
      contentHtml: "<p>Which runtime?</p>",
      language: "en",
      tags: {},
      emojis: {},
      url: `http://localhost/@${values.account.username}/${postId}`,
      published,
      updated: published,
    } satisfies NewPost,
  );
  await tx.insert(pollTable).values({
    postId,
    multiple: false,
    votersCount: 0,
    ends: new Date(published.getTime() + 24 * 60 * 60 * 1000),
  });
  await tx.insert(pollOptionTable).values(
    values.optionTitles.map((title, index) => ({
      postId,
      index,
      title,
      votesCount: 0,
    })),
  );
  return await tx.query.postTable.findFirst({ where: { id: postId } });
}

test("onPostPinned ignores tags.pub hashtag actors without fetching them", async () => {
  let actorFetches = 0;
  const add = {
    actorId: new URL("https://tags.pub/user/rust"),
    targetId: new URL("https://tags.pub/user/rust/collections/featured"),
    objectId: new URL("https://example.com/posts/1"),
    getActor() {
      actorFetches++;
      throw new Error("unexpected actor fetch");
    },
  } as unknown as Add;

  await onPostPinned({} as InboxContext<ContextData>, add);

  assert.equal(actorFetches, 0);
});

test("onPostUnpinned ignores tags.pub hashtag actors without fetching them", async () => {
  let actorFetches = 0;
  const remove = {
    actorId: new URL("https://tags.pub/user/rust"),
    targetId: new URL("https://tags.pub/user/rust/collections/featured"),
    objectId: new URL("https://example.com/posts/1"),
    getActor() {
      actorFetches++;
      throw new Error("unexpected actor fetch");
    },
  } as unknown as Remove;

  await onPostUnpinned({} as InboxContext<ContextData>, remove);

  assert.equal(actorFetches, 0);
});

test("onPostCreated stores a remote poll vote", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "inboxpollauthor",
      name: "Inbox Poll Author",
      email: "inboxpollauthor@example.com",
    });
    const voter = await insertRemoteActor(tx, {
      username: "inboxpollvoter",
      name: "Inbox Poll Voter",
      host: "remote.example",
      iri: "https://remote.example/users/inboxpollvoter",
    });
    const post = await insertQuestionPoll(tx, {
      account: author.account,
      optionTitles: ["Deno", "Node.js"],
    });
    assert.ok(post != null);
    const create = new Create({
      id: new URL("https://remote.example/votes/1/activity"),
      actor: new URL(voter.iri),
      object: new Note({
        id: new URL("https://remote.example/votes/1"),
        attribution: new URL(voter.iri),
        name: "Node.js",
        replyTarget: new URL(post.iri),
      }),
    });

    await onPostCreated(
      createFedCtx(tx) as unknown as InboxContext<ContextData>,
      create,
    );

    const votes = await tx.query.pollVoteTable.findMany({
      where: { postId: post.id },
    });
    assert.equal(votes.length, 1);
    assert.equal(votes[0].actorId, voter.id);
    assert.equal(votes[0].optionIndex, 1);

    const poll = await tx.query.pollTable.findFirst({
      where: { postId: post.id },
    });
    assert.equal(poll?.votersCount, 1);
    const options = await tx.query.pollOptionTable.findMany({
      where: { postId: post.id },
      orderBy: { index: "asc" },
    });
    assert.deepEqual(options.map((option) => option.votesCount), [0, 1]);
  });
});
