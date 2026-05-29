import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { eq } from "drizzle-orm";
import { follow } from "./following.ts";
import { mute } from "./muting.ts";
import { sharePost } from "./post.ts";
import { postTable } from "./schema.ts";
import {
  addPostToTimeline,
  expandLocales,
  removeFromTimeline,
} from "./timeline.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertMention,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

Deno.test("expandLocales() returns the locale unchanged when no region", () => {
  assertEquals(expandLocales(["ko"]), ["ko"]);
  assertEquals(expandLocales(["en"]), ["en"]);
  assertEquals(expandLocales(["zh"]), ["zh"]);
});

Deno.test(
  "expandLocales() adds base language when region-specific locale is given",
  () => {
    assertEquals(expandLocales(["ko-KR"]), ["ko-KR", "ko"]);
    assertEquals(expandLocales(["en-US"]), ["en-US", "en"]);
    assertEquals(expandLocales(["zh-TW"]), ["zh-TW", "zh"]);
  },
);

Deno.test("expandLocales() deduplicates when base locale is also listed", () => {
  assertEquals(expandLocales(["ko-KR", "ko"]), ["ko-KR", "ko"]);
});

Deno.test("expandLocales() expands multiple region-specific locales", () => {
  assertEquals(expandLocales(["ko-KR", "en-US"]), [
    "ko-KR",
    "ko",
    "en-US",
    "en",
  ]);
});

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
      const remoteAuthorSuffix = crypto.randomUUID().replaceAll("-", "").slice(
        0,
        8,
      );
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
        username: `remoteauthor${remoteAuthorSuffix}`,
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

Deno.test({
  name:
    "removeFromTimeline() does not fall back to a sharer the viewer has muted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const viewer = await insertAccountWithActor(tx, {
        username: "mutefallbackviewer",
        name: "Mute Fallback Viewer",
        email: "mutefallbackviewer@example.com",
      });
      const mutedSharer = await insertAccountWithActor(tx, {
        username: "mutefallbackmuted",
        name: "Mute Fallback Muted",
        email: "mutefallbackmuted@example.com",
      });
      const latestSharer = await insertAccountWithActor(tx, {
        username: "mutefallbacklatest",
        name: "Mute Fallback Latest",
        email: "mutefallbacklatest@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: `mutefallbackremote${suffix}`,
        name: "Mute Fallback Remote",
        host: "mute-fallback.example",
      });
      const originalPost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Shared by a muted and an unmuted account</p>",
      });

      await follow(fedCtx, viewer.account, mutedSharer.actor);
      await follow(fedCtx, viewer.account, latestSharer.actor);

      // Muted sharer boosts first, the unmuted account boosts last.
      const mutedShare = await sharePost(fedCtx, mutedSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      const latestShare = await sharePost(fedCtx, latestSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      await tx.update(postTable)
        .set({ published: new Date("2026-04-15T00:00:01.000Z") })
        .where(eq(postTable.id, mutedShare.id));
      await tx.update(postTable)
        .set({ published: new Date("2026-04-15T00:00:02.000Z") })
        .where(eq(postTable.id, latestShare.id));

      // Mute the older sharer (the latest sharer still backs the row).
      await mute(tx, viewer.account, mutedSharer.actor);

      // The latest (unmuted) sharer unshares. The fallback must NOT resurrect
      // the muted sharer; with no unmuted sharer left, the row is dropped.
      await tx.delete(postTable).where(eq(postTable.id, latestShare.id));
      await removeFromTimeline(tx, latestShare);

      const after = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assertEquals(after, undefined);
    });
  },
});

Deno.test({
  name:
    "removeFromTimeline() does not fall back to a sharer whose boost is not visible to the viewer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const viewer = await insertAccountWithActor(tx, {
        username: "visfallbackviewer",
        name: "Vis Fallback Viewer",
        email: "visfallbackviewer@example.com",
      });
      const hiddenSharer = await insertAccountWithActor(tx, {
        username: "visfallbackhidden",
        name: "Vis Fallback Hidden",
        email: "visfallbackhidden@example.com",
      });
      const latestSharer = await insertAccountWithActor(tx, {
        username: "visfallbacklatest",
        name: "Vis Fallback Latest",
        email: "visfallbacklatest@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: `visfallbackremote${suffix}`,
        name: "Vis Fallback Remote",
        host: "vis-fallback.example",
      });
      const originalPost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Shared by a hidden and a visible account</p>",
      });

      await follow(fedCtx, viewer.account, hiddenSharer.actor);
      await follow(fedCtx, viewer.account, latestSharer.actor);

      const hiddenShare = await sharePost(fedCtx, hiddenSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      const latestShare = await sharePost(fedCtx, latestSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      // Demote the first boost to a non-fanned-out visibility: it must not be
      // resurrected as the fallback sharer.
      await tx.update(postTable)
        .set({ visibility: "none" })
        .where(eq(postTable.id, hiddenShare.id));

      // The visible (latest) sharer unshares. No visible sharer remains, so the
      // share-only row is dropped rather than falling back to the hidden boost.
      await tx.delete(postTable).where(eq(postTable.id, latestShare.id));
      await removeFromTimeline(tx, latestShare);

      const after = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assertEquals(after, undefined);
    });
  },
});
