import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  deletePersistedPost,
  deleteSharedPost,
  getPostByUsernameAndId,
} from "./post.ts";
import { postTable } from "./schema.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

test("getPostByUsernameAndId() requires a full handle and returns a matching post", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "getpostowner",
      name: "Get Post Owner",
      email: "getpostowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Lookup by handle",
    });

    assert.equal(
      await getPostByUsernameAndId(
        tx,
        account.account.username,
        post.id,
        account.account,
      ),
      undefined,
    );

    const found = await getPostByUsernameAndId(
      tx,
      `${account.account.username}@localhost`,
      post.id,
      account.account,
    );

    assert.ok(found != null);
    assert.equal(found.id, post.id);
    assert.equal(found.actor.id, account.actor.id);
  });
});

test("deletePersistedPost() removes a remote reply and decrements the parent reply count", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "remoteauthor",
      name: "Remote Author",
      host: "remote.example",
    });
    const parent = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Remote parent</p>",
    });
    const reply = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Remote reply</p>",
      replyTargetId: parent.id,
    });
    await tx.update(postTable)
      .set({ repliesCount: 1 })
      .where(eq(postTable.id, parent.id));

    const deleted = await deletePersistedPost(
      tx,
      new URL(reply.iri),
      new URL(remoteActor.iri),
    );

    assert.equal(deleted, true);
    const remainingReply = await tx.query.postTable.findFirst({
      where: { id: reply.id },
    });
    assert.equal(remainingReply, undefined);

    const updatedParent = await tx.query.postTable.findFirst({
      where: { id: parent.id },
    });
    assert.ok(updatedParent != null);
    assert.equal(updatedParent.repliesCount, 0);
  });
});

test("deleteSharedPost() removes a remote share and decrements the target share count", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "remotesharer",
      name: "Remote Sharer",
      host: "remote.example",
    });
    const original = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Original remote post</p>",
    });
    const share = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Shared remote post</p>",
      sharedPostId: original.id,
    });
    await tx.update(postTable)
      .set({ sharesCount: 1 })
      .where(eq(postTable.id, original.id));

    const deletedShare = await deleteSharedPost(
      tx,
      new URL(share.iri),
      new URL(remoteActor.iri),
    );

    assert.ok(deletedShare != null);
    assert.equal(deletedShare.id, share.id);
    assert.equal(deletedShare.actor.id, remoteActor.id);

    const remainingShare = await tx.query.postTable.findFirst({
      where: { id: share.id },
    });
    assert.equal(remainingShare, undefined);

    const updatedOriginal = await tx.query.postTable.findFirst({
      where: { id: original.id },
    });
    assert.ok(updatedOriginal != null);
    assert.equal(updatedOriginal.sharesCount, 0);
  });
});
