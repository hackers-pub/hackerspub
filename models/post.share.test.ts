import assert from "node:assert";
import test from "node:test";
import { arePostsSharedBy, sharePost } from "./post.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("arePostsSharedBy() returns the subset of posts the account has shared", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "aresharedauthor",
      name: "AreShared Author",
      email: "aresharedauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "aresharedsharer",
      name: "AreShared Sharer",
      email: "aresharedsharer@example.com",
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

    await sharePost(fedCtx, sharer.account, {
      ...postA,
      actor: author.actor,
    });
    await sharePost(fedCtx, sharer.account, {
      ...postC,
      actor: author.actor,
    });

    const result = await arePostsSharedBy(
      tx,
      [postA.id, postB.id, postC.id],
      sharer.account,
    );

    assert.deepEqual(result, new Set([postA.id, postC.id]));
  });
});

test("arePostsSharedBy() returns an empty set when the account shared none", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "aresharednoneauthor",
      name: "AreShared None Author",
      email: "aresharednoneauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "aresharednonesharer",
      name: "AreShared None Sharer",
      email: "aresharednonesharer@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Untouched",
    });

    const result = await arePostsSharedBy(tx, [post.id], sharer.account);

    assert.deepEqual(result, new Set());
  });
});

test("arePostsSharedBy() returns an empty set for an empty input list", async () => {
  await withRollback(async (tx) => {
    const sharer = await insertAccountWithActor(tx, {
      username: "aresharedemptysharer",
      name: "AreShared Empty Sharer",
      email: "aresharedemptysharer@example.com",
    });

    const result = await arePostsSharedBy(tx, [], sharer.account);

    assert.deepEqual(result, new Set());
  });
});
