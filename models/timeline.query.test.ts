import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { and, eq } from "drizzle-orm";
import { follow } from "./following.ts";
import { sharePost } from "./post.ts";
import {
  addPostToTimeline,
  getPersonalTimeline,
  getPublicTimeline,
} from "./timeline.ts";
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
  name: "getPublicTimeline() hydrates large windows in bounded batches",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "publiclargebatchauthor",
        name: "Public Large Batch Author",
        email: "publiclargebatchauthor@example.com",
      });
      const posts = [];
      const timestamp = new Date("2026-04-15T00:00:01.000Z");
      for (let i = 1; i <= 300; i++) {
        const { post } = await insertNotePost(tx, {
          account: author.account,
          content: `Public large batch post ${i}`,
          published: timestamp,
        });
        posts.push(post);
      }
      const orderedPosts = [...posts].sort((a, b) => b.id.localeCompare(a.id));

      const timeline = await getPublicTimeline(tx, { window: 300 });
      assertEquals(timeline.length, 300);
      assertEquals(
        timeline.map((entry) => entry.post.id),
        orderedPosts.map((post) => post.id),
      );
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

Deno.test({
  name:
    "getPublicTimeline() filters by base language code with prefix matching",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "publictimelinelangauthor",
        name: "Public Timeline Language Author",
        email: "publictimelinelangauthor@example.com",
      });
      const ts = new Date("2026-04-15T12:00:00.000Z");
      const { post: enPost } = await insertNotePost(tx, {
        account: author.account,
        content: "English post",
        language: "en",
        published: new Date(ts.getTime() + 3000),
      });
      const { post: enUsPost } = await insertNotePost(tx, {
        account: author.account,
        content: "English US post",
        language: "en-US",
        published: new Date(ts.getTime() + 2000),
      });
      const { post: enGbPost } = await insertNotePost(tx, {
        account: author.account,
        content: "English GB post",
        language: "en-GB",
        published: new Date(ts.getTime() + 1500),
      });
      const { post: koPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Korean post",
        language: "ko",
        published: new Date(ts.getTime() + 1000),
      });

      // Bound the query to just the window covered by this test's posts so
      // that any pre-existing rows in the shared database don't interfere.
      const scope = {
        since: { timestamp: ts },
        until: { timestamp: new Date(ts.getTime() + 4000) },
      };

      const enOnly = await getPublicTimeline(tx, {
        ...scope,
        languages: new Set(["en"]),
        window: 10,
      });
      assertEquals(
        enOnly.map((e) => e.post.id),
        [enPost.id, enUsPost.id, enGbPost.id],
        "base language 'en' matches 'en', 'en-US', and 'en-GB'",
      );

      const koOnly = await getPublicTimeline(tx, {
        ...scope,
        languages: new Set(["ko"]),
        window: 10,
      });
      assertEquals(
        koOnly.map((e) => e.post.id),
        [koPost.id],
        "base language 'ko' matches only 'ko'",
      );

      const all = await getPublicTimeline(tx, { ...scope, window: 10 });
      const allIds = all.map((e) => e.post.id);
      assert(
        allIds.includes(enPost.id) &&
          allIds.includes(enUsPost.id) &&
          allIds.includes(enGbPost.id) &&
          allIds.includes(koPost.id),
        "empty languages returns all posts",
      );

      // Region-specific locales are normalized to base for content filtering:
      // "en-US" → "en", so it matches "en", "en-US", and "en-GB" (all English
      // variants). This is intentional — content filtering is language-level,
      // not region-level.
      const enUsAsBase = await getPublicTimeline(tx, {
        ...scope,
        languages: new Set(["en-US"]),
        window: 10,
      });
      assertEquals(
        enUsAsBase.map((e) => e.post.id),
        [enPost.id, enUsPost.id, enGbPost.id],
        "'en-US' normalizes to 'en' and matches all English variants",
      );
    });
  },
});

Deno.test({
  name:
    "getPersonalTimeline() filters by base language code with prefix matching",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const viewer = await insertAccountWithActor(tx, {
        username: "personallangviewer",
        name: "Personal Language Viewer",
        email: "personallangviewer@example.com",
      });
      const author = await insertAccountWithActor(tx, {
        username: "personallangauthor",
        name: "Personal Language Author",
        email: "personallangauthor@example.com",
      });

      await follow(fedCtx, viewer.account, author.actor);

      const ts = new Date("2026-04-15T13:00:00.000Z");
      const { post: enPost } = await insertNotePost(tx, {
        account: author.account,
        content: "English post",
        language: "en",
        published: new Date(ts.getTime() + 2000),
      });
      await addPostToTimeline(tx, enPost);
      const { post: enGbPost } = await insertNotePost(tx, {
        account: author.account,
        content: "English GB post",
        language: "en-GB",
        published: new Date(ts.getTime() + 1000),
      });
      await addPostToTimeline(tx, enGbPost);
      const { post: jaPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Japanese post",
        language: "ja",
        published: ts,
      });
      await addPostToTimeline(tx, jaPost);

      const enOnly = await getPersonalTimeline(tx, {
        currentAccount: viewer.account,
        languages: new Set(["en"]),
        window: 10,
      });
      assertEquals(
        enOnly.map((e) => e.post.id),
        [enPost.id, enGbPost.id],
        "base language 'en' matches both 'en' and 'en-GB'",
      );

      const jaOnly = await getPersonalTimeline(tx, {
        currentAccount: viewer.account,
        languages: new Set(["ja"]),
        window: 10,
      });
      assertEquals(
        jaOnly.map((e) => e.post.id),
        [jaPost.id],
        "base language 'ja' matches only 'ja'",
      );

      const all = await getPersonalTimeline(tx, {
        currentAccount: viewer.account,
        window: 10,
      });
      const allIds = all.map((e) => e.post.id);
      assert(
        allIds.includes(enPost.id) &&
          allIds.includes(enGbPost.id) &&
          allIds.includes(jaPost.id),
        "empty languages returns all posts",
      );
    });
  },
});
