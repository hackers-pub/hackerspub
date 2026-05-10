import { assertEquals } from "@std/assert/equals";
import { and, eq } from "drizzle-orm";
import { follow } from "./following.ts";
import { sharePost } from "./post.ts";
import { getPersonalTimeline, getPublicTimeline } from "./timeline.ts";
import { postTable, timelineItemTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name: "getPublicTimeline() applies local and withoutShares filters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const localAuthor = await insertAccountWithActor(tx, {
        username: "publiclocalauthor",
        name: "Public Local Author",
        email: "publiclocalauthor@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "publicsharer",
        name: "Public Sharer",
        email: "publicsharer@example.com",
      });
      const { post: localPost } = await insertNotePost(tx, {
        account: localAuthor.account,
        content: "Local public post",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "publicremote",
        name: "Public Remote",
        host: "remote.example",
      });
      const remotePost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Remote public post</p>",
      });
      const share = await sharePost(fedCtx, sharer.account, {
        ...remotePost,
        actor: remoteActor,
      });

      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:01.000Z"),
          updated: new Date("2026-04-15T00:00:01.000Z"),
        })
        .where(eq(postTable.id, localPost.id));
      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:02.000Z"),
          updated: new Date("2026-04-15T00:00:02.000Z"),
        })
        .where(eq(postTable.id, remotePost.id));
      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:03.000Z"),
          updated: new Date("2026-04-15T00:00:03.000Z"),
        })
        .where(eq(postTable.id, share.id));

      const all = await getPublicTimeline(tx, { window: 10 });
      assertEquals(all.map((entry) => entry.post.id), [
        share.id,
        remotePost.id,
        localPost.id,
      ]);

      const localOnly = await getPublicTimeline(tx, {
        local: true,
        window: 10,
      });
      assertEquals(localOnly.map((entry) => entry.post.id), [
        share.id,
        localPost.id,
      ]);

      const localWithoutShares = await getPublicTimeline(tx, {
        local: true,
        withoutShares: true,
        window: 10,
      });
      assertEquals(localWithoutShares.map((entry) => entry.post.id), [
        localPost.id,
      ]);
    });
  },
});

Deno.test({
  name: "getPublicTimeline() uses exclusive cursors without gaps",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "publiccursorauthor",
        name: "Public Cursor Author",
        email: "publiccursorauthor@example.com",
      });
      const posts = [];
      const timestamp = new Date("2026-04-15T00:00:01.000Z");
      for (let i = 1; i <= 4; i++) {
        const { post } = await insertNotePost(tx, {
          account: author.account,
          content: `Public cursor post ${i}`,
          published: timestamp,
        });
        posts.push(post);
      }
      const orderedPosts = [...posts].sort((a, b) => b.id.localeCompare(a.id));

      const firstPage = await getPublicTimeline(tx, { window: 3 });
      assertEquals(firstPage.map((entry) => entry.post.id), [
        orderedPosts[0].id,
        orderedPosts[1].id,
        orderedPosts[2].id,
      ]);

      const nextCursor = {
        timestamp: firstPage[1].cursor,
        postId: firstPage[1].post.id,
      };
      const secondPage = await getPublicTimeline(tx, {
        until: nextCursor,
        window: 2,
      });
      assertEquals(secondPage.map((entry) => entry.post.id), [
        orderedPosts[2].id,
        orderedPosts[3].id,
      ]);
    });
  },
});

Deno.test({
  name: "getPersonalTimeline() hides pure shares when withoutShares is enabled",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const viewer = await insertAccountWithActor(tx, {
        username: "personaltimelineviewer",
        name: "Personal Timeline Viewer",
        email: "personaltimelineviewer@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "personaltimelinesharer",
        name: "Personal Timeline Sharer",
        email: "personaltimelinesharer@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "personaltimelineremote",
        name: "Personal Timeline Remote",
        host: "remote.timeline.example",
      });
      const remotePost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Remote timeline post</p>",
      });

      await follow(fedCtx, viewer.account, sharer.actor);
      const share = await sharePost(fedCtx, sharer.account, {
        ...remotePost,
        actor: remoteActor,
      });

      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:04.000Z"),
          updated: new Date("2026-04-15T00:00:04.000Z"),
        })
        .where(eq(postTable.id, share.id));

      const timeline = await getPersonalTimeline(tx, {
        currentAccount: viewer.account,
        window: 10,
      });
      assertEquals(timeline.length, 1);
      assertEquals(timeline[0].post.id, remotePost.id);
      assertEquals(timeline[0].lastSharer?.id, sharer.actor.id);
      assertEquals(timeline[0].sharersCount, 1);

      const withoutShares = await getPersonalTimeline(tx, {
        currentAccount: viewer.account,
        withoutShares: true,
        window: 10,
      });
      assertEquals(withoutShares, []);
    });
  },
});

Deno.test({
  name: "getPersonalTimeline() uses appended cursors without gaps",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const viewer = await insertAccountWithActor(tx, {
        username: "personalcursorviewer",
        name: "Personal Cursor Viewer",
        email: "personalcursorviewer@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "personalcursorsharer",
        name: "Personal Cursor Sharer",
        email: "personalcursorsharer@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "personalcursorremote",
        name: "Personal Cursor Remote",
        host: "personal-cursor.example",
      });

      await follow(fedCtx, viewer.account, sharer.actor);

      const posts = [];
      const timestamp = new Date("2026-04-15T00:01:00.000Z");
      for (let i = 1; i <= 4; i++) {
        const remotePost = await insertRemotePost(tx, {
          actorId: remoteActor.id,
          contentHtml: `<p>Personal cursor post ${i}</p>`,
          published: timestamp,
        });
        const share = await sharePost(fedCtx, sharer.account, {
          ...remotePost,
          actor: remoteActor,
        });
        await tx.update(postTable)
          .set({ published: timestamp, updated: timestamp })
          .where(eq(postTable.id, share.id));
        await tx.update(timelineItemTable)
          .set({ appended: timestamp })
          .where(
            and(
              eq(timelineItemTable.accountId, viewer.account.id),
              eq(timelineItemTable.postId, remotePost.id),
            ),
          );
        posts.push(remotePost);
      }
      const orderedPosts = [...posts].sort((a, b) => b.id.localeCompare(a.id));

      const firstPage = await getPersonalTimeline(tx, {
        currentAccount: viewer.account,
        window: 3,
      });
      assertEquals(firstPage.map((entry) => entry.post.id), [
        orderedPosts[0].id,
        orderedPosts[1].id,
        orderedPosts[2].id,
      ]);

      const nextCursor = {
        timestamp: firstPage[1].cursor,
        postId: firstPage[1].post.id,
      };
      const secondPage = await getPersonalTimeline(tx, {
        currentAccount: viewer.account,
        until: nextCursor,
        window: 2,
      });
      assertEquals(secondPage.map((entry) => entry.post.id), [
        orderedPosts[2].id,
        orderedPosts[3].id,
      ]);
    });
  },
});
