import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import {
  createFollowNotification,
  createShareNotification,
  deleteShareNotification,
  getNotifications,
} from "./notification.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name: "createShareNotification() merges repeated shares into one row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assert(firstNotification != null);
      assert(secondNotification != null);
      assertEquals(secondNotification.id, firstNotification.id);

      const storedNotifications = await tx.query.notificationTable.findMany({
        where: {
          accountId: author.account.id,
          type: "share",
          postId: post.id,
        },
      });
      assertEquals(storedNotifications.length, 1);
      assertEquals(storedNotifications[0].actorIds, [
        firstSharer.actor.id,
        secondSharer.actor.id,
      ]);
      assertEquals(
        storedNotifications[0].created.toISOString(),
        newer.toISOString(),
      );
    });
  },
});

Deno.test({
  name: "deleteShareNotification() prunes merged actors and deletes empty rows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assert(pruned != null);
      assertEquals(pruned.actorIds, [secondSharer.actor.id]);

      const remainingNotification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: author.account.id,
          type: "share",
          postId: post.id,
        },
      });
      assert(remainingNotification != null);
      assertEquals(remainingNotification.actorIds, [secondSharer.actor.id]);

      const deleted = await deleteShareNotification(
        tx,
        author.account.id,
        post,
        secondSharer.actor,
      );

      assert(deleted != null);
      assertEquals(deleted.actorIds, []);

      const removedNotification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: author.account.id,
          type: "share",
          postId: post.id,
        },
      });
      assertEquals(removedNotification, undefined);
    });
  },
});

Deno.test({
  name: "getNotifications() returns newest notifications with loaded relations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(notifications.length, 2);
      assertEquals(notifications[0].type, "follow");
      assertEquals(notifications[0].post, null);
      assertEquals(notifications[0].account.id, recipient.account.id);

      assertEquals(notifications[1].type, "share");
      assert(notifications[1].post != null);
      assertEquals(notifications[1].post.id, post.id);
      assertEquals(notifications[1].post.actor.id, recipient.actor.id);
      assertEquals(notifications[1].post.actor.instance.host, "localhost");
      assertEquals(notifications[1].account.id, recipient.account.id);
      assertEquals(notifications[1].customEmoji, null);
    });
  },
});

Deno.test({
  name:
    "createFollowNotification() returns the existing row for duplicate follows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assert(first != null);
      assert(second != null);
      assert(duplicate != null);
      assertEquals(duplicate.id, first.id);

      const notifications = await tx.query.notificationTable.findMany({
        where: {
          accountId: recipient.account.id,
          type: "follow",
        },
        orderBy: { created: "asc" },
      });
      assertEquals(notifications.length, 2);
      assertEquals(
        notifications.map((notification) => notification.actorIds),
        [[firstFollower.actor.id], [secondFollower.actor.id]],
      );
    });
  },
});
