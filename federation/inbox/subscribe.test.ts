import assert from "node:assert";
import test from "node:test";
import type { InboxContext } from "@fedify/fedify";
import {
  Announce,
  Create,
  Hashtag,
  Note,
  PUBLIC_COLLECTION,
} from "@fedify/vocab";
import type { Add, Remove } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import {
  hashtagFollowingTable,
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
import {
  onPostCreated,
  onPostPinned,
  onPostShared,
  onPostUnpinned,
} from "./subscribe.ts";

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

test("onPostShared relays tags.pub announces without fetching the hashtag actor", async () => {
  await withRollback(async (tx) => {
    const author = await insertRemoteActor(tx, {
      username: "tagspubauthor",
      name: "Tags Pub Author",
      host: "remote.example",
      iri: "https://remote.example/users/tagspubauthor",
    });
    const follower = await insertAccountWithActor(tx, {
      username: "tagspubfollower",
      name: "Tags Pub Follower",
      email: "tagspubfollower@example.com",
    });
    await tx.insert(hashtagFollowingTable).values({
      accountId: follower.account.id,
      tag: "rust",
    });
    let actorFetches = 0;
    const note = new Note({
      id: new URL("https://remote.example/posts/rust"),
      attribution: new URL(author.iri),
      content: "Rust release notes",
      tags: [
        new Hashtag({
          name: "#rust",
          href: new URL("https://tags.pub/tags/rust"),
        }),
      ],
      to: PUBLIC_COLLECTION,
    });
    const announce = new Announce({
      id: new URL("https://tags.pub/activities/rust/1"),
      actor: new URL("https://tags.pub/user/rust"),
      object: note,
    });
    announce.getActor = (() => {
      actorFetches++;
      throw new Error("unexpected tags.pub actor fetch");
    }) as Announce["getActor"];

    await onPostShared(
      createFedCtx(tx) as unknown as InboxContext<ContextData>,
      announce,
    );

    assert.equal(actorFetches, 0);
    const posts = await tx.query.postTable.findMany({
      where: { iri: "https://remote.example/posts/rust" },
    });
    assert.equal(posts.length, 1);
    const shares = await tx.query.postTable.findMany({
      where: { sharedPostId: posts[0].id },
    });
    assert.equal(shares.length, 0);
    const timelineItem = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: follower.account.id,
        postId: posts[0].id,
      },
    });
    assert.ok(timelineItem != null);
    assert.equal(timelineItem.originalAuthorId, posts[0].actorId);
    assert.equal(timelineItem.lastSharerId, null);
  });
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

test("onPostCreated ignores rejected poll vote attempts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "inboxrejectedpollauthor",
      name: "Inbox Rejected Poll Author",
      email: "inboxrejectedpollauthor@example.com",
    });
    const voter = await insertRemoteActor(tx, {
      username: "inboxrejectedpollvoter",
      name: "Inbox Rejected Poll Voter",
      host: "remote.example",
      iri: "https://remote.example/users/inboxrejectedpollvoter",
    });
    const post = await insertQuestionPoll(tx, {
      account: author.account,
      optionTitles: ["Deno", "Node.js"],
    });
    assert.ok(post != null);
    const create = new Create({
      id: new URL("https://remote.example/votes/rejected/activity"),
      actor: new URL(voter.iri),
      object: new Note({
        id: new URL("https://remote.example/votes/rejected"),
        attribution: new URL(voter.iri),
        name: "Node.js",
        replyTarget: new URL(post.iri),
      }),
    });
    const fedCtx = createFedCtx(tx) as unknown as InboxContext<ContextData>;

    await onPostCreated(fedCtx, create);
    await onPostCreated(fedCtx, create);
    await onPostCreated(
      fedCtx,
      new Create({
        id: new URL("https://remote.example/votes/unknown/activity"),
        actor: new URL(voter.iri),
        object: new Note({
          id: new URL("https://remote.example/votes/unknown"),
          attribution: new URL(voter.iri),
          name: "Bun",
          replyTarget: new URL(post.iri),
        }),
      }),
    );

    const votes = await tx.query.pollVoteTable.findMany({
      where: { postId: post.id },
    });
    assert.equal(votes.length, 1);

    const replies = await tx.query.postTable.findMany({
      where: { replyTargetId: post.id },
    });
    assert.equal(replies.length, 0);
  });
});

test("onPostCreated stores named replies to questions as posts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "inboxnamedreplypollauthor",
      name: "Inbox Named Reply Poll Author",
      email: "inboxnamedreplypollauthor@example.com",
    });
    const replier = await insertRemoteActor(tx, {
      username: "inboxnamedreplyreplier",
      name: "Inbox Named Reply Replier",
      host: "remote.example",
      iri: "https://remote.example/users/inboxnamedreplyreplier",
    });
    const post = await insertQuestionPoll(tx, {
      account: author.account,
      optionTitles: ["Deno", "Node.js"],
    });
    assert.ok(post != null);

    await onPostCreated(
      createFedCtx(tx) as unknown as InboxContext<ContextData>,
      new Create({
        id: new URL("https://remote.example/replies/named/activity"),
        actor: new URL(replier.iri),
        object: new Note({
          id: new URL("https://remote.example/replies/named"),
          attribution: new URL(replier.iri),
          name: "Bun",
          content: "I prefer Bun, even though it is not an option.",
          replyTarget: new URL(post.iri),
        }),
      }),
    );

    const votes = await tx.query.pollVoteTable.findMany({
      where: { postId: post.id },
    });
    assert.equal(votes.length, 0);

    const replies = await tx.query.postTable.findMany({
      where: { replyTargetId: post.id },
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].name, "Bun");
    assert.match(replies[0].contentHtml, /prefer Bun/);
  });
});
