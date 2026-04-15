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
