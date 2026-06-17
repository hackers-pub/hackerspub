import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  AccountDeletionUnavailableError,
  deleteAccount,
  isUsernameReserved,
} from "./account.ts";
import { flagCaseTable, postTable } from "./schema.ts";
import { updateAccountData } from "./account.ts";
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
    fedCtx.sendActivity = ((...args: unknown[]) => {
      sentActivities.push(args);
      return Promise.resolve(undefined);
    }) as typeof fedCtx.sendActivity;

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
    await tx.update(postTable)
      .set({ repliesCount: 1, sharesCount: 1, quotesCount: 1 })
      .where(eq(postTable.id, parentPost.id));

    const result = await deleteAccount(fedCtx, target.account.id);

    assert.ok(result != null);
    assert.equal(result.accountId, target.account.id);
    assert.equal(result.username, "deleterenamed");
    assert.ok(result.deleted instanceof Date);

    assert.equal(sentActivities.length, 1);
    assert.deepEqual(sentActivities[0][1], "followers");

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
  });
});

test("deleteAccount() aborts when the actor Delete cannot be enqueued", async () => {
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

    await assert.rejects(
      () => deleteAccount(fedCtx, target.account.id),
      /queue unavailable/,
    );

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

test("deleteAccount() refuses accounts linked to moderation audit records", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    let sent = false;
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
