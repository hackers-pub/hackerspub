import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  AccountDeletionUnavailableError,
  deleteAccount,
  isUsernameReserved,
  updateAccountData,
} from "./account.ts";
import { createFollowNotification } from "./notification.ts";
import { react } from "./reaction.ts";
import {
  accountKeyTable,
  actorTable,
  flagCaseTable,
  followingTable,
  pollOptionTable,
  pollTable,
  pollVoteTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("deleteAccount() hard-deletes an account and reserves the current username", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const sentActivities: unknown[][] = [];

    const survivor = await insertAccountWithActor(tx, {
      username: "deleteparent",
      name: "Delete Parent",
      email: "deleteparent@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deletecurrent",
      name: "Delete Current",
      email: "deletecurrent@example.com",
    });
    const renamed = await updateAccountData(tx, {
      id: target.account.id,
      username: "deleterenamed",
    });
    assert.ok(renamed != null);

    const { post: parentPost } = await insertNotePost(tx, {
      account: survivor.account,
      content: "Parent post",
    });
    const { post: replyPost } = await insertNotePost(tx, {
      account: target.account,
      content: "Reply",
      replyTargetId: parentPost.id,
    });
    const { post: sharePost } = await insertNotePost(tx, {
      account: target.account,
      content: "Share",
      sharedPostId: parentPost.id,
    });
    const { post: quotePost } = await insertNotePost(tx, {
      account: target.account,
      content: "Quote",
      quotedPostId: parentPost.id,
    });
    await tx.insert(accountKeyTable).values({
      accountId: target.account.id,
      type: "RSASSA-PKCS1-v1_5",
      public: { kty: "test-public" },
      private: { kty: "test-private" },
    });
    await tx.update(postTable)
      .set({ repliesCount: 1, sharesCount: 1, quotesCount: 1 })
      .where(eq(postTable.id, parentPost.id));

    let sendObservedState:
      | {
        accountExists: boolean;
        tombstoneUsername: string | undefined;
        preservedKeyTypes: string[];
      }
      | undefined;
    fedCtx.sendActivity = (async (...args: unknown[]) => {
      sentActivities.push(args);
      const account = await tx.query.accountTable.findFirst({
        where: { id: target.account.id },
        columns: { id: true },
      });
      const tombstone = await tx.query.deletedAccountTable.findFirst({
        where: { accountId: target.account.id },
      });
      const preservedKeys = await tx.query.deletedAccountKeyTable.findMany({
        where: { accountId: target.account.id },
        columns: { type: true },
        orderBy: { type: "asc" },
      });
      sendObservedState = {
        accountExists: account != null,
        tombstoneUsername: tombstone?.username,
        preservedKeyTypes: preservedKeys.map((key) => key.type),
      };
    }) as typeof fedCtx.sendActivity;

    const result = await deleteAccount(fedCtx, target.account.id);

    assert.ok(result != null);
    assert.equal(result.accountId, target.account.id);
    assert.equal(result.username, "deleterenamed");
    assert.ok(result.deleted instanceof Date);

    assert.equal(sentActivities.length, 1);
    assert.deepEqual(sentActivities[0][1], "followers");
    assert.deepEqual(sendObservedState, {
      accountExists: false,
      tombstoneUsername: "deleterenamed",
      preservedKeyTypes: ["RSASSA-PKCS1-v1_5"],
    });

    const account = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.equal(account, undefined);
    const actor = await tx.query.actorTable.findFirst({
      where: { id: target.actor.id },
    });
    assert.equal(actor, undefined);
    const deletedPosts = await tx.query.postTable.findMany({
      where: { id: { in: [replyPost.id, sharePost.id, quotePost.id] } },
    });
    assert.deepEqual(deletedPosts, []);

    const refreshedParent = await tx.query.postTable.findFirst({
      where: { id: parentPost.id },
    });
    assert.ok(refreshedParent != null);
    assert.equal(refreshedParent.repliesCount, 0);
    assert.equal(refreshedParent.sharesCount, 0);
    assert.equal(refreshedParent.quotesCount, 0);

    const tombstone = await tx.query.deletedAccountTable.findFirst({
      where: { accountId: target.account.id },
    });
    assert.ok(tombstone != null);
    assert.equal(tombstone.username, "deleterenamed");
    assert.equal(await isUsernameReserved(tx, "deleterenamed"), true);
    assert.equal(await isUsernameReserved(tx, "deletecurrent"), false);
    const preservedKeys = await tx.query.deletedAccountKeyTable.findMany({
      where: { accountId: target.account.id },
    });
    assert.equal(preservedKeys.length, 1);
    assert.equal(preservedKeys[0].type, "RSASSA-PKCS1-v1_5");
  });
});

test("deleteAccount() refreshes denormalized interaction state", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const survivor = await insertAccountWithActor(tx, {
      username: "deletesurvivor",
      name: "Delete Survivor",
      email: "deletesurvivor@example.com",
    });
    const target = await insertAccountWithActor(tx, {
      username: "deleteinteractions",
      name: "Delete Interactions",
      email: "deleteinteractions@example.com",
    });
    const bystander = await insertAccountWithActor(tx, {
      username: "deletebystander",
      name: "Delete Bystander",
      email: "deletebystander@example.com",
    });
    const accepted = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(followingTable).values([
      {
        iri: `http://localhost/follows/${generateUuidV7()}`,
        followerId: target.actor.id,
        followeeId: survivor.actor.id,
        accepted,
      },
      {
        iri: `http://localhost/follows/${generateUuidV7()}`,
        followerId: bystander.actor.id,
        followeeId: target.actor.id,
        accepted,
      },
    ]);
    await tx.update(actorTable)
      .set({ followersCount: 1 })
      .where(eq(actorTable.id, survivor.actor.id));
    await tx.update(actorTable)
      .set({ followeesCount: 1 })
      .where(eq(actorTable.id, bystander.actor.id));
    await createFollowNotification(
      tx,
      survivor.account.id,
      target.actor,
      accepted,
    );

    const { post } = await insertNotePost(tx, {
      account: survivor.account,
      content: "Surviving post",
    });
    await react(
      fedCtx,
      target.account,
      { ...post, actor: survivor.actor },
      "🎉",
    );
    await react(
      fedCtx,
      bystander.account,
      { ...post, actor: survivor.actor },
      "🎉",
    );

    await tx.insert(pollTable).values({
      postId: post.id,
      multiple: false,
      votersCount: 2,
      ends: new Date("2026-04-16T00:00:00.000Z"),
    });
    await tx.insert(pollOptionTable).values([
      { postId: post.id, index: 0, title: "Delete", votesCount: 1 },
      { postId: post.id, index: 1, title: "Keep", votesCount: 1 },
    ]);
    await tx.insert(pollVoteTable).values([
      { postId: post.id, optionIndex: 0, actorId: target.actor.id },
      { postId: post.id, optionIndex: 1, actorId: bystander.actor.id },
    ]);

    await deleteAccount(fedCtx, target.account.id);

    const refreshedSurvivor = await tx.query.actorTable.findFirst({
      where: { id: survivor.actor.id },
    });
    assert.equal(refreshedSurvivor?.followersCount, 0);

    const refreshedBystander = await tx.query.actorTable.findFirst({
      where: { id: bystander.actor.id },
    });
    assert.equal(refreshedBystander?.followeesCount, 0);

    const refreshedPost = await tx.query.postTable.findFirst({
      where: { id: post.id },
    });
    assert.deepEqual(refreshedPost?.reactionsCounts, { "🎉": 1 });

    const reactNotification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: survivor.account.id,
        type: "react",
        postId: post.id,
      },
    });
    assert.deepEqual(reactNotification?.actorIds, [bystander.actor.id]);

    const followNotification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: survivor.account.id,
        type: "follow",
      },
    });
    assert.equal(followNotification, undefined);

    const refreshedPoll = await tx.query.pollTable.findFirst({
      where: { postId: post.id },
    });
    assert.equal(refreshedPoll?.votersCount, 1);

    const refreshedOptions = await tx.query.pollOptionTable.findMany({
      where: { postId: post.id },
      orderBy: { index: "asc" },
    });
    assert.deepEqual(
      refreshedOptions.map((option) => option.votesCount),
      [0, 1],
    );
  });
});

test("deleteAccount() keeps the deletion when actor Delete enqueue fails", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.sendActivity = (() =>
      Promise.reject(
        new Error("queue unavailable"),
      )) as typeof fedCtx.sendActivity;
    const target = await insertAccountWithActor(tx, {
      username: "deletequeuefail",
      name: "Delete Queue Fail",
      email: "deletequeuefail@example.com",
    });

    const result = await deleteAccount(fedCtx, target.account.id);

    assert.equal(result?.accountId, target.account.id);
    const account = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.equal(account, undefined);
    const tombstone = await tx.query.deletedAccountTable.findFirst({
      where: { accountId: target.account.id },
    });
    assert.equal(tombstone?.username, "deletequeuefail");
  });
});

test("deleteAccount() refuses accounts linked to moderation audit records", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    let sent = false;
    let keyPairsRequested = false;
    (fedCtx as unknown as {
      getActorKeyPairs: (identifier: string) => Promise<unknown[]>;
    }).getActorKeyPairs = () => {
      keyPairsRequested = true;
      return Promise.resolve([]);
    };
    fedCtx.sendActivity = (() => {
      sent = true;
      return Promise.resolve(undefined);
    }) as typeof fedCtx.sendActivity;
    const target = await insertAccountWithActor(tx, {
      username: "deleteaudit",
      name: "Delete Audit",
      email: "deleteaudit@example.com",
    });
    await tx.insert(flagCaseTable).values({
      id: generateUuidV7(),
      targetActorId: target.actor.id,
      status: "pending",
    });

    await assert.rejects(
      () => deleteAccount(fedCtx, target.account.id),
      AccountDeletionUnavailableError,
    );

    assert.equal(sent, false);
    assert.equal(keyPairsRequested, false);
    const account = await tx.query.accountTable.findFirst({
      where: { id: target.account.id },
    });
    assert.ok(account != null);
    const tombstone = await tx.query.deletedAccountTable.findFirst({
      where: { accountId: target.account.id },
    });
    assert.equal(tombstone, undefined);
  });
});
