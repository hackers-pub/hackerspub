import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { eq, inArray } from "drizzle-orm";
import { deletePost, sharePost } from "./post.ts";
import { noteSourceTable, notificationTable, postTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name: "deletePost() removes a reply and decrements the parent reply count",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "replyparent",
        name: "Reply Parent",
        email: "replyparent@example.com",
      });
      const replier = await insertAccountWithActor(tx, {
        username: "replychild",
        name: "Reply Child",
        email: "replychild@example.com",
      });
      const { post: rootPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Root post",
      });
      const { noteSourceId: replySourceId, post: replyPost } =
        await insertNotePost(
          tx,
          {
            account: replier.account,
            content: "Reply post",
            replyTargetId: rootPost.id,
          },
        );

      await tx.update(postTable)
        .set({ repliesCount: 1 })
        .where(eq(postTable.id, rootPost.id));

      await deletePost(fedCtx, {
        ...replyPost,
        actor: replier.actor,
        replyTarget: rootPost,
      });

      const storedRoot = await tx.query.postTable.findFirst({
        where: { id: rootPost.id },
      });
      assert(storedRoot != null);
      assertEquals(storedRoot.repliesCount, 0);

      const storedReply = await tx.query.postTable.findFirst({
        where: { id: replyPost.id },
      });
      assertEquals(storedReply, undefined);

      const replySource = await tx.query.noteSourceTable.findFirst({
        where: { id: replySourceId },
      });
      assertEquals(replySource, undefined);
    });
  },
});

Deno.test({
  name:
    "deletePost() cascades through local replies, shares, and notifications",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "cascadeauthor",
        name: "Cascade Author",
        email: "cascadeauthor@example.com",
      });
      const replier = await insertAccountWithActor(tx, {
        username: "cascadereplier",
        name: "Cascade Replier",
        email: "cascadereplier@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "cascadesharer",
        name: "Cascade Sharer",
        email: "cascadesharer@example.com",
      });
      const { noteSourceId: rootSourceId, post: rootPost } =
        await insertNotePost(
          tx,
          {
            account: author.account,
            content: "Cascade root",
          },
        );
      const { noteSourceId: replySourceId, post: replyPost } =
        await insertNotePost(
          tx,
          {
            account: replier.account,
            content: "Cascade reply",
            replyTargetId: rootPost.id,
          },
        );

      await tx.update(postTable)
        .set({ repliesCount: 1 })
        .where(eq(postTable.id, rootPost.id));

      const share = await sharePost(fedCtx, sharer.account, {
        ...rootPost,
        actor: author.actor,
      });

      await deletePost(fedCtx, {
        ...rootPost,
        actor: author.actor,
        replyTarget: null,
      });

      const remainingPosts = await tx.select({ id: postTable.id }).from(
        postTable,
      )
        .where(inArray(postTable.id, [rootPost.id, replyPost.id, share.id]));
      assertEquals(remainingPosts, []);

      const remainingSources = await tx.select({ id: noteSourceTable.id })
        .from(noteSourceTable)
        .where(inArray(noteSourceTable.id, [rootSourceId, replySourceId]));
      assertEquals(remainingSources, []);

      const notification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: author.account.id,
          type: "share",
          postId: rootPost.id,
        },
      });
      assertEquals(notification, undefined);

      const notificationRows = await tx.select().from(notificationTable);
      assertEquals(notificationRows, []);
    });
  },
});
