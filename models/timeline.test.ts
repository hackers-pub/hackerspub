import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { eq } from "drizzle-orm";
import { follow } from "./following.ts";
import { sharePost } from "./post.ts";
import { postTable } from "./schema.ts";
import { addPostToTimeline, removeFromTimeline } from "./timeline.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertMention,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name:
    "addPostToTimeline() delivers direct posts only to the author and mentions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "timelinedirectauthor",
        name: "Timeline Direct Author",
        email: "timelinedirectauthor@example.com",
      });
      const follower = await insertAccountWithActor(tx, {
        username: "timelinedirectfollower",
        name: "Timeline Direct Follower",
        email: "timelinedirectfollower@example.com",
      });
      const mentioned = await insertAccountWithActor(tx, {
        username: "timelinedirectmention",
        name: "Timeline Direct Mention",
        email: "timelinedirectmention@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Direct post",
        visibility: "direct",
      });

      await follow(fedCtx, follower.account, author.actor);
      await insertMention(tx, { postId: post.id, actorId: mentioned.actor.id });

      await addPostToTimeline(tx, post);

      const timelineItems = await tx.query.timelineItemTable.findMany({
        where: { postId: post.id },
        orderBy: { accountId: "asc" },
      });

      assertEquals(
        timelineItems.map((item) => item.accountId).sort(),
        [author.account.id, mentioned.account.id].sort(),
      );
      assert(
        !timelineItems.some((item) => item.accountId === follower.account.id),
      );
    });
  },
});

Deno.test({
  name: "removeFromTimeline() falls back to the previous sharer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const viewer = await insertAccountWithActor(tx, {
        username: "timelineviewer",
        name: "Timeline Viewer",
        email: "timelineviewer@example.com",
      });
      const firstSharer = await insertAccountWithActor(tx, {
        username: "timelinefirstsharer",
        name: "Timeline First Sharer",
        email: "timelinefirstsharer@example.com",
      });
      const secondSharer = await insertAccountWithActor(tx, {
        username: "timelinesecondsharer",
        name: "Timeline Second Sharer",
        email: "timelinesecondsharer@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "remoteauthor",
        name: "Remote Author",
        host: "remote.example",
      });
      const originalPost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Shared timeline post</p>",
      });

      await follow(fedCtx, viewer.account, firstSharer.actor);
      await follow(fedCtx, viewer.account, secondSharer.actor);

      const firstShare = await sharePost(fedCtx, firstSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      const secondShare = await sharePost(fedCtx, secondSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });

      const firstPublished = new Date("2026-04-15T00:00:01.000Z");
      const secondPublished = new Date("2026-04-15T00:00:02.000Z");

      await tx.update(postTable)
        .set({ published: firstPublished, updated: firstPublished })
        .where(eq(postTable.id, firstShare.id));
      await tx.update(postTable)
        .set({ published: secondPublished, updated: secondPublished })
        .where(eq(postTable.id, secondShare.id));

      const before = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assert(before != null);
      assertEquals(before.lastSharerId, secondSharer.actor.id);
      assertEquals(before.sharersCount, 2);

      await tx.delete(postTable).where(eq(postTable.id, secondShare.id));
      await removeFromTimeline(tx, secondShare);

      const after = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assert(after != null);
      assertEquals(after.lastSharerId, firstSharer.actor.id);
      assertEquals(after.sharersCount, 1);
      assertEquals(after.appended.toISOString(), firstPublished.toISOString());
    });
  },
});
