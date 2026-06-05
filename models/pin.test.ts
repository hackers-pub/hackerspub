import assert from "node:assert/strict";
import test from "node:test";
import { Add, Remove } from "@fedify/vocab";
import {
  arePostsPinnedBy,
  MAX_PINNED_POSTS,
  pinPost,
  unpinPost,
} from "./pin.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("pinPost() pins and unpins own public posts", async () => {
  await withRollback(async (tx) => {
    const sent: unknown[][] = [];
    const baseFedCtx = createFedCtx(tx);
    const fedCtx = {
      ...baseFedCtx,
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as typeof baseFedCtx;
    const author = await insertAccountWithActor(tx, {
      username: "pinauthor",
      name: "Pin Author",
      email: "pinauthor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Pinned post",
    });

    const pinned = await pinPost(fedCtx, author.actor, post);
    assert.equal(pinned?.actorId, author.actor.id);
    assert.equal(pinned?.postId, post.id);
    assert.equal(sent.length, 1);
    assert.ok(sent[0][2] instanceof Add);

    const again = await pinPost(fedCtx, author.actor, post);
    assert.equal(again?.created.getTime(), pinned?.created.getTime());
    assert.equal(sent.length, 1);

    const rows = await tx.query.pinTable.findMany({
      where: { actorId: author.actor.id },
    });
    assert.equal(rows.length, 1);

    const unpinned = await unpinPost(fedCtx, author.actor, post);
    assert.equal(unpinned?.postId, post.id);
    assert.equal(sent.length, 2);
    assert.ok(sent[1][2] instanceof Remove);

    const alreadyUnpinned = await unpinPost(fedCtx, author.actor, post);
    assert.equal(alreadyUnpinned, null);
    assert.equal(sent.length, 2);

    const remaining = await tx.query.pinTable.findMany({
      where: { actorId: author.actor.id },
    });
    assert.deepEqual(remaining, []);
  });
});

test("pinPost() rejects ineligible posts", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "pinrejectauthor",
      name: "Pin Reject Author",
      email: "pinrejectauthor@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "pinrejectother",
      name: "Pin Reject Other",
      email: "pinrejectother@example.com",
    });
    const { post: privatePost } = await insertNotePost(tx, {
      account: author.account,
      content: "Followers-only post",
      visibility: "followers",
    });
    const { post: otherPost } = await insertNotePost(tx, {
      account: other.account,
      content: "Other user's post",
    });
    const { post: original } = await insertNotePost(tx, {
      account: author.account,
      content: "Original post",
    });
    const { post: share } = await insertNotePost(tx, {
      account: author.account,
      content: "Share post",
      sharedPostId: original.id,
    });

    assert.equal(await pinPost(fedCtx, author.actor, privatePost), null);
    assert.equal(await pinPost(fedCtx, author.actor, otherPost), null);
    assert.equal(await pinPost(fedCtx, author.actor, share), null);

    const rows = await tx.query.pinTable.findMany({
      where: { actorId: author.actor.id },
    });
    assert.deepEqual(rows, []);
  });
});

test("pinPost() enforces per-actor limit", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "pinlimitauthor",
      name: "Pin Limit Author",
      email: "pinlimitauthor@example.com",
    });
    for (let i = 0; i < MAX_PINNED_POSTS; i++) {
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: `Pinned post ${i}`,
      });
      assert.notEqual(await pinPost(fedCtx, author.actor, post), null);
    }

    const { post: extra } = await insertNotePost(tx, {
      account: author.account,
      content: "Extra pinned post",
    });
    assert.equal(await pinPost(fedCtx, author.actor, extra), null);

    const rows = await tx.query.pinTable.findMany({
      where: { actorId: author.actor.id },
    });
    assert.equal(rows.length, MAX_PINNED_POSTS);
  });
});

test("arePostsPinnedBy() returns the subset of posts the actor has pinned", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "arepinnedauthor",
      name: "ArePinned Author",
      email: "arepinnedauthor@example.com",
    });

    const { post: postA } = await insertNotePost(tx, {
      account: author.account,
      content: "A",
    });
    const { post: postB } = await insertNotePost(tx, {
      account: author.account,
      content: "B",
    });
    const { post: postC } = await insertNotePost(tx, {
      account: author.account,
      content: "C",
    });

    assert.notEqual(await pinPost(fedCtx, author.actor, postA), null);
    assert.notEqual(await pinPost(fedCtx, author.actor, postC), null);

    const result = await arePostsPinnedBy(
      tx,
      [postA.id, postB.id, postC.id],
      author.actor,
    );

    assert.deepEqual(result, new Set([postA.id, postC.id]));
  });
});

test("arePostsPinnedBy() returns an empty set when no pins match", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "arepinnednoneauthor",
      name: "ArePinned None Author",
      email: "arepinnednoneauthor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Untouched",
    });

    const result = await arePostsPinnedBy(tx, [post.id], author.actor);

    assert.deepEqual(result, new Set());
  });
});

test("arePostsPinnedBy() returns an empty set for an empty input list", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "arepinnedemptyauthor",
      name: "ArePinned Empty Author",
      email: "arepinnedemptyauthor@example.com",
    });

    const result = await arePostsPinnedBy(tx, [], author.actor);

    assert.deepEqual(result, new Set());
  });
});
