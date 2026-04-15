import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import {
  createShareNotification,
  deleteShareNotification,
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
