import assert from "node:assert";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../graphql/db.ts";
import {
  createFollowNotification,
  createOrganizationInvitationNotification,
  createShareNotification,
  deleteShareNotification,
  getNotifications,
} from "./notification.ts";
import { accountTable, notificationTable } from "./schema.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("createShareNotification() merges repeated shares into one row", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "notifyauthor",
      name: "Notify Author",
      email: "notifyauthor@example.com",
    });
    const firstSharer = await insertAccountWithActor(tx, {
      username: "firstsharer",
      name: "First Sharer",
      email: "firstsharer@example.com",
    });
    const secondSharer = await insertAccountWithActor(tx, {
      username: "secondsharer",
      name: "Second Sharer",
      email: "secondsharer@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Shared target",
    });
    const older = new Date("2026-04-15T00:00:00.000Z");
    const newer = new Date("2026-04-15T01:00:00.000Z");

    const firstNotification = await createShareNotification(
      tx,
      author.account.id,
      post,
      firstSharer.actor,
      older,
    );
    const secondNotification = await createShareNotification(
      tx,
      author.account.id,
      post,
      secondSharer.actor,
      newer,
    );

    assert.ok(firstNotification != null);
    assert.ok(secondNotification != null);
    assert.deepEqual(secondNotification.id, firstNotification.id);

    const storedNotifications = await tx.query.notificationTable.findMany({
      where: {
        accountId: author.account.id,
        type: "share",
        postId: post.id,
      },
    });
    assert.deepEqual(storedNotifications.length, 1);
    assert.deepEqual(storedNotifications[0].actorIds, [
      firstSharer.actor.id,
      secondSharer.actor.id,
    ]);
    assert.deepEqual(
      storedNotifications[0].created.toISOString(),
      newer.toISOString(),
    );
  });
});

test("createOrganizationInvitationNotification() works with a plain database", async () => {
  const usernames = [
    "plainorginvitationmember",
    "plainorginvitationorg",
  ];
  let member:
    | Awaited<ReturnType<typeof insertAccountWithActor>>
    | undefined;
  let organization:
    | Awaited<ReturnType<typeof insertAccountWithActor>>
    | undefined;
  try {
    await db.transaction(async (tx) => {
      member = await insertAccountWithActor(tx, {
        username: usernames[0],
        name: "Plain Org Invitation Member",
        email: "plainorginvitationmember@example.com",
      });
      organization = await insertAccountWithActor(tx, {
        username: usernames[1],
        name: "Plain Org Invitation Org",
        email: "plainorginvitationorg@example.com",
        kind: "organization",
        type: "Organization",
      });
    });
    assert.ok(member != null);
    assert.ok(organization != null);

    const notification = await createOrganizationInvitationNotification(
      db,
      member.account.id,
      organization.actor.id,
    );

    assert.ok(notification != null);
    assert.equal(notification.accountId, member.account.id);
    assert.equal(notification.type, "organization_invitation");
    assert.deepEqual(notification.actorIds, [organization.actor.id]);
  } finally {
    await db.delete(notificationTable).where(sql`
      ${notificationTable.accountId} = ${member?.account.id ?? null}
    `);
    await db.delete(accountTable).where(sql`
      ${accountTable.username} IN (${usernames[0]}, ${usernames[1]})
    `);
  }
});

test("deleteShareNotification() prunes merged actors and deletes empty rows", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "deletenotifyauthor",
      name: "Delete Notify Author",
      email: "deletenotifyauthor@example.com",
    });
    const firstSharer = await insertAccountWithActor(tx, {
      username: "deletefirstsharer",
      name: "Delete First Sharer",
      email: "deletefirstsharer@example.com",
    });
    const secondSharer = await insertAccountWithActor(tx, {
      username: "deletesecondsharer",
      name: "Delete Second Sharer",
      email: "deletesecondsharer@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Delete shared target",
    });

    await createShareNotification(
      tx,
      author.account.id,
      post,
      firstSharer.actor,
    );
    await createShareNotification(
      tx,
      author.account.id,
      post,
      secondSharer.actor,
    );

    const pruned = await deleteShareNotification(
      tx,
      author.account.id,
      post,
      firstSharer.actor,
    );

    assert.ok(pruned != null);
    assert.deepEqual(pruned.actorIds, [secondSharer.actor.id]);

    const remainingNotification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: author.account.id,
        type: "share",
        postId: post.id,
      },
    });
    assert.ok(remainingNotification != null);
    assert.deepEqual(remainingNotification.actorIds, [secondSharer.actor.id]);

    const deleted = await deleteShareNotification(
      tx,
      author.account.id,
      post,
      secondSharer.actor,
    );

    assert.ok(deleted != null);
    assert.deepEqual(deleted.actorIds, []);

    const removedNotification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: author.account.id,
        type: "share",
        postId: post.id,
      },
    });
    assert.deepEqual(removedNotification, undefined);
  });
});

test("getNotifications() returns newest notifications with loaded relations", async () => {
  await withRollback(async (tx) => {
    const recipient = await insertAccountWithActor(tx, {
      username: "notificationrecipient",
      name: "Notification Recipient",
      email: "notificationrecipient@example.com",
    });
    const follower = await insertAccountWithActor(tx, {
      username: "notificationfollower",
      name: "Notification Follower",
      email: "notificationfollower@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "notificationsharer",
      name: "Notification Sharer",
      email: "notificationsharer@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: recipient.account,
      content: "Shared in notification list",
    });

    await createShareNotification(
      tx,
      recipient.account.id,
      post,
      sharer.actor,
      new Date("2026-04-15T00:00:00.000Z"),
    );
    await createFollowNotification(
      tx,
      recipient.account.id,
      follower.actor,
      new Date("2026-04-15T01:00:00.000Z"),
    );

    const notifications = await getNotifications(
      tx,
      recipient.account.id,
      new Date("2026-04-15T23:59:59.000Z"),
    );

    assert.deepEqual(notifications.length, 2);
    assert.deepEqual(notifications[0].type, "follow");
    assert.deepEqual(notifications[0].post, null);
    assert.deepEqual(notifications[0].account.id, recipient.account.id);

    assert.deepEqual(notifications[1].type, "share");
    assert.ok(notifications[1].post != null);
    assert.deepEqual(notifications[1].post.id, post.id);
    assert.deepEqual(notifications[1].post.actor.id, recipient.actor.id);
    assert.deepEqual(notifications[1].post.actor.instance.host, "localhost");
    assert.deepEqual(notifications[1].account.id, recipient.account.id);
    assert.deepEqual(notifications[1].customEmoji, null);
  });
});

test(
  "createFollowNotification() returns the existing row for duplicate follows",
  async () => {
    await withRollback(async (tx) => {
      const recipient = await insertAccountWithActor(tx, {
        username: "followrecipient",
        name: "Follow Recipient",
        email: "followrecipient@example.com",
      });
      const firstFollower = await insertAccountWithActor(tx, {
        username: "firstfollower",
        name: "First Follower",
        email: "firstfollower@example.com",
      });
      const secondFollower = await insertAccountWithActor(tx, {
        username: "secondfollower",
        name: "Second Follower",
        email: "secondfollower@example.com",
      });

      const first = await createFollowNotification(
        tx,
        recipient.account.id,
        firstFollower.actor,
        new Date("2026-04-15T00:00:00.000Z"),
      );
      const second = await createFollowNotification(
        tx,
        recipient.account.id,
        secondFollower.actor,
        new Date("2026-04-15T01:00:00.000Z"),
      );
      const duplicate = await createFollowNotification(
        tx,
        recipient.account.id,
        firstFollower.actor,
        new Date("2026-04-15T02:00:00.000Z"),
      );

      assert.ok(first != null);
      assert.ok(second != null);
      assert.ok(duplicate != null);
      assert.deepEqual(duplicate.id, first.id);

      const notifications = await tx.query.notificationTable.findMany({
        where: {
          accountId: recipient.account.id,
          type: "follow",
        },
        orderBy: { created: "asc" },
      });
      assert.deepEqual(notifications.length, 2);
      assert.deepEqual(
        notifications.map((notification) => notification.actorIds),
        [[firstFollower.actor.id], [secondFollower.actor.id]],
      );
    });
  },
);
