import assert from "node:assert/strict";
import test from "node:test";
import { createShareNotification } from "./notification.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("createShareNotification() keeps the newest created time when older events merge later", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "orderingauthor",
      name: "Ordering Author",
      email: "orderingauthor@example.com",
    });
    const newerSharer = await insertAccountWithActor(tx, {
      username: "newersharer",
      name: "Newer Sharer",
      email: "newersharer@example.com",
    });
    const olderSharer = await insertAccountWithActor(tx, {
      username: "oldersharer",
      name: "Older Sharer",
      email: "oldersharer@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Notification ordering target",
    });
    const newer = new Date("2026-04-15T01:00:00.000Z");
    const older = new Date("2026-04-15T00:00:00.000Z");

    await createShareNotification(
      tx,
      author.account.id,
      post,
      newerSharer.actor,
      newer,
    );
    const merged = await createShareNotification(
      tx,
      author.account.id,
      post,
      olderSharer.actor,
      older,
    );

    assert.ok(merged != null);
    assert.equal(merged.created.toISOString(), newer.toISOString());

    const stored = await tx.query.notificationTable.findFirst({
      where: {
        accountId: author.account.id,
        type: "share",
        postId: post.id,
      },
    });
    assert.ok(stored != null);
    assert.equal(stored.created.toISOString(), newer.toISOString());
  });
});

test("createShareNotification() keeps the existing row unchanged for replayed same-actor events", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "replayauthor",
      name: "Replay Author",
      email: "replayauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "replaysharer",
      name: "Replay Sharer",
      email: "replaysharer@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Notification replay target",
    });
    const newer = new Date("2026-04-15T01:00:00.000Z");
    const older = new Date("2026-04-15T00:00:00.000Z");

    const created = await createShareNotification(
      tx,
      author.account.id,
      post,
      sharer.actor,
      newer,
    );
    const replayed = await createShareNotification(
      tx,
      author.account.id,
      post,
      sharer.actor,
      older,
    );

    assert.ok(created != null);
    assert.ok(replayed != null);
    assert.equal(replayed.id, created.id);
    assert.equal(replayed.created.toISOString(), newer.toISOString());
    assert.deepEqual(replayed.actorIds, [sharer.actor.id]);

    const stored = await tx.query.notificationTable.findFirst({
      where: {
        accountId: author.account.id,
        type: "share",
        postId: post.id,
      },
    });
    assert.ok(stored != null);
    assert.equal(stored.created.toISOString(), newer.toISOString());
    assert.deepEqual(stored.actorIds, [sharer.actor.id]);
  });
});

test("createShareNotification() only merges the matching notification row", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "scopemergeauthor",
      name: "Scope Merge Author",
      email: "scopemergeauthor@example.com",
    });
    const firstSharer = await insertAccountWithActor(tx, {
      username: "scopefirstsharer",
      name: "Scope First Sharer",
      email: "scopefirstsharer@example.com",
    });
    const secondSharer = await insertAccountWithActor(tx, {
      username: "scopesecondsharer",
      name: "Scope Second Sharer",
      email: "scopesecondsharer@example.com",
    });
    const { post: firstPost } = await insertNotePost(tx, {
      account: author.account,
      content: "First scoped notification target",
    });
    const { post: secondPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Second scoped notification target",
    });
    const firstCreated = new Date("2026-04-15T00:00:00.000Z");
    const secondCreated = new Date("2026-04-15T00:30:00.000Z");
    const mergedCreated = new Date("2026-04-15T01:00:00.000Z");

    const first = await createShareNotification(
      tx,
      author.account.id,
      firstPost,
      firstSharer.actor,
      firstCreated,
    );
    const second = await createShareNotification(
      tx,
      author.account.id,
      secondPost,
      secondSharer.actor,
      secondCreated,
    );
    const merged = await createShareNotification(
      tx,
      author.account.id,
      firstPost,
      secondSharer.actor,
      mergedCreated,
    );

    assert.ok(first != null);
    assert.ok(second != null);
    assert.ok(merged != null);
    assert.equal(merged.id, first.id);

    const storedFirst = await tx.query.notificationTable.findFirst({
      where: { id: first.id },
    });
    const storedSecond = await tx.query.notificationTable.findFirst({
      where: { id: second.id },
    });
    assert.ok(storedFirst != null);
    assert.ok(storedSecond != null);
    assert.equal(
      storedFirst.created.toISOString(),
      mergedCreated.toISOString(),
    );
    assert.deepEqual(storedFirst.actorIds, [
      firstSharer.actor.id,
      secondSharer.actor.id,
    ]);
    assert.equal(
      storedSecond.created.toISOString(),
      secondCreated.toISOString(),
    );
    assert.deepEqual(storedSecond.actorIds, [secondSharer.actor.id]);
  });
});
