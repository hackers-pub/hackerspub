import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { and, eq } from "drizzle-orm";
import { follow } from "./following.ts";
import { sharePost, unsharePost } from "./post.ts";
import { postTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name: "sharePost() creates a share, timeline entry, and notification",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "shareauthor",
        name: "Share Author",
        email: "shareauthor@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "sharer",
        name: "Sharer",
        email: "sharer@example.com",
      });
      const follower = await insertAccountWithActor(tx, {
        username: "sharefollower",
        name: "Share Follower",
        email: "sharefollower@example.com",
      });
      const { post: originalPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Original post",
      });

      await follow(fedCtx, follower.account, sharer.actor);

      const share = await sharePost(fedCtx, sharer.account, {
        ...originalPost,
        actor: author.actor,
      });

      assertEquals(share.sharedPostId, originalPost.id);

      const storedOriginal = await tx.query.postTable.findFirst({
        where: { id: originalPost.id },
      });
      assert(storedOriginal != null);
      assertEquals(storedOriginal.sharesCount, 1);

      const timelineItem = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: follower.account.id,
          postId: originalPost.id,
        },
      });
      assert(timelineItem != null);
      assertEquals(timelineItem.originalAuthorId, null);
      assertEquals(timelineItem.lastSharerId, sharer.actor.id);
      assertEquals(timelineItem.sharersCount, 1);

      const notification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: author.account.id,
          type: "share",
          postId: originalPost.id,
        },
      });
      assert(notification != null);
      assertEquals(notification.actorIds, [sharer.actor.id]);
    });
  },
});

Deno.test({
  name: "sharePost() is idempotent for duplicate shares",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "dupshareauthor",
        name: "Dup Share Author",
        email: "dupshareauthor@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "dupsharer",
        name: "Dup Sharer",
        email: "dupsharer@example.com",
      });
      const { post: originalPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Duplicate share target",
      });

      const first = await sharePost(fedCtx, sharer.account, {
        ...originalPost,
        actor: author.actor,
      });
      const second = await sharePost(fedCtx, sharer.account, {
        ...originalPost,
        actor: author.actor,
      });

      assertEquals(second.id, first.id);

      const shares = await tx.query.postTable.findMany({
        where: {
          actorId: sharer.actor.id,
          sharedPostId: originalPost.id,
        },
      });
      assertEquals(shares.length, 1);

      const storedOriginal = await tx.query.postTable.findFirst({
        where: { id: originalPost.id },
      });
      assert(storedOriginal != null);
      assertEquals(storedOriginal.sharesCount, 1);
    });
  },
});

Deno.test({
  name: "unsharePost() removes the share, timeline entry, and notification",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "unshareauthor",
        name: "Unshare Author",
        email: "unshareauthor@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "unsharer",
        name: "Unsharer",
        email: "unsharer@example.com",
      });
      const follower = await insertAccountWithActor(tx, {
        username: "unsharefollower",
        name: "Unshare Follower",
        email: "unsharefollower@example.com",
      });
      const { post: originalPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Unshare target",
      });

      await follow(fedCtx, follower.account, sharer.actor);
      await sharePost(fedCtx, sharer.account, {
        ...originalPost,
        actor: author.actor,
      });

      const removed = await unsharePost(fedCtx, sharer.account, {
        ...originalPost,
        actor: author.actor,
      });

      assert(removed != null);

      const shares = await tx.select().from(postTable).where(and(
        eq(postTable.actorId, sharer.actor.id),
        eq(postTable.sharedPostId, originalPost.id),
      ));
      assertEquals(shares, []);

      const storedOriginal = await tx.query.postTable.findFirst({
        where: { id: originalPost.id },
      });
      assert(storedOriginal != null);
      assertEquals(storedOriginal.sharesCount, 0);

      const timelineItem = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: follower.account.id,
          postId: originalPost.id,
        },
      });
      assertEquals(timelineItem, undefined);

      const notification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: author.account.id,
          type: "share",
          postId: originalPost.id,
        },
      });
      assertEquals(notification, undefined);
    });
  },
});
