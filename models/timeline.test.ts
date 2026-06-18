import assert from "node:assert";
import test from "node:test";
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

test("expandLocales() returns the locale unchanged when no region", () => {
  assert.deepEqual(expandLocales(["ko"]), ["ko"]);
  assert.deepEqual(expandLocales(["en"]), ["en"]);
  assert.deepEqual(expandLocales(["zh"]), ["zh"]);
});

test(
  "expandLocales() adds base language when region-specific locale is given",
  () => {
    assert.deepEqual(expandLocales(["ko-KR"]), ["ko-KR", "ko"]);
    assert.deepEqual(expandLocales(["en-US"]), ["en-US", "en"]);
    assert.deepEqual(expandLocales(["zh-TW"]), ["zh-TW", "zh"]);
  },
);

test("expandLocales() deduplicates when base locale is also listed", () => {
  assert.deepEqual(expandLocales(["ko-KR", "ko"]), ["ko-KR", "ko"]);
});

test("expandLocales() expands multiple region-specific locales", () => {
  assert.deepEqual(expandLocales(["ko-KR", "en-US"]), [
    "ko-KR",
    "ko",
    "en-US",
    "en",
  ]);
});

test(
  "addPostToTimeline() delivers direct posts only to the author and mentions",
  async () => {
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

      assert.deepEqual(
        timelineItems.map((item) => item.accountId).sort(),
        [author.account.id, mentioned.account.id].sort(),
      );
      assert.ok(
        !timelineItems.some((item) => item.accountId === follower.account.id),
      );
    });
  },
);

test("removeFromTimeline() falls back to the previous sharer", async () => {
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
    assert.ok(before != null);
    assert.deepEqual(before.lastSharerId, secondSharer.actor.id);
    assert.deepEqual(before.sharersCount, 2);

    await tx.delete(postTable).where(eq(postTable.id, secondShare.id));
    await removeFromTimeline(tx, secondShare);

    const after = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: viewer.account.id,
        postId: originalPost.id,
      },
    });
    assert.ok(after != null);
    assert.deepEqual(after.lastSharerId, firstSharer.actor.id);
    assert.deepEqual(after.sharersCount, 1);
    assert.deepEqual(
      after.appended.toISOString(),
      firstPublished.toISOString(),
    );
  });
});

test(
  "removeFromTimeline() preserves a surviving share delivered by mention",
  async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const viewer = await insertAccountWithActor(tx, {
        username: "timementionviewer",
        name: "Timeline Mention Viewer",
        email: "timementionviewer@example.com",
      });
      const followedSharer = await insertAccountWithActor(tx, {
        username: "timementionfollowed",
        name: "Timeline Mention Followed",
        email: "timementionfollowed@example.com",
      });
      const mentionedSharer = await insertAccountWithActor(tx, {
        username: "timementionsharer",
        name: "Timeline Mention Sharer",
        email: "timementionsharer@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: `timementionremote${suffix}`,
        name: "Timeline Mention Remote",
        host: "timeline-mention.example",
      });
      const originalPost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Shared by follow and mention paths</p>",
      });

      await follow(fedCtx, viewer.account, followedSharer.actor);

      const followedShare = await sharePost(fedCtx, followedSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      const mentionedShare = await sharePost(fedCtx, mentionedSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      const followedPublished = new Date("2026-04-15T00:00:01.000Z");
      const mentionedPublished = new Date("2026-04-15T00:00:02.000Z");
      await tx.update(postTable)
        .set({ published: followedPublished, updated: followedPublished })
        .where(eq(postTable.id, followedShare.id));
      await tx.update(postTable)
        .set({ published: mentionedPublished, updated: mentionedPublished })
        .where(eq(postTable.id, mentionedShare.id));

      await insertMention(tx, {
        postId: mentionedShare.id,
        actorId: viewer.actor.id,
      });
      const updatedMentionedShare = await tx.query.postTable.findFirst({
        where: { id: mentionedShare.id },
      });
      assert.ok(updatedMentionedShare != null);
      await addPostToTimeline(tx, updatedMentionedShare);

      const before = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assert.ok(before != null);
      assert.deepEqual(before.lastSharerId, mentionedSharer.actor.id);
      assert.deepEqual(before.sharersCount, 2);

      await tx.delete(postTable).where(eq(postTable.id, followedShare.id));
      await removeFromTimeline(tx, followedShare);

      const after = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assert.ok(after != null);
      assert.deepEqual(after.lastSharerId, mentionedSharer.actor.id);
      assert.deepEqual(after.sharersCount, 1);
      assert.deepEqual(
        after.appended.toISOString(),
        mentionedPublished.toISOString(),
      );
    });
  },
);

test(
  "removeFromTimeline() preserves a surviving share delivered by quote",
  async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const viewer = await insertAccountWithActor(tx, {
        username: "timequoteviewer",
        name: "Timeline Quote Viewer",
        email: "timequoteviewer@example.com",
      });
      const followedSharer = await insertAccountWithActor(tx, {
        username: "timequotefollowed",
        name: "Timeline Quote Followed",
        email: "timequotefollowed@example.com",
      });
      const quotedSharer = await insertAccountWithActor(tx, {
        username: "timequotesharer",
        name: "Timeline Quote Sharer",
        email: "timequotesharer@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: `timequoteremote${suffix}`,
        name: "Timeline Quote Remote",
        host: "timeline-quote.example",
      });
      const originalPost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Shared by follow and quote paths</p>",
      });
      const { post: quotedTarget } = await insertNotePost(tx, {
        account: viewer.account,
        content: "A post quoted by the surviving share",
      });

      await follow(fedCtx, viewer.account, followedSharer.actor);

      const followedShare = await sharePost(fedCtx, followedSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      const quotedShare = await sharePost(fedCtx, quotedSharer.account, {
        ...originalPost,
        actor: remoteActor,
      });
      const followedPublished = new Date("2026-04-15T00:00:01.000Z");
      const quotedPublished = new Date("2026-04-15T00:00:02.000Z");
      await tx.update(postTable)
        .set({ published: followedPublished, updated: followedPublished })
        .where(eq(postTable.id, followedShare.id));
      await tx.update(postTable)
        .set({
          published: quotedPublished,
          updated: quotedPublished,
          quotedPostId: quotedTarget.id,
        })
        .where(eq(postTable.id, quotedShare.id));

      const updatedQuotedShare = await tx.query.postTable.findFirst({
        where: { id: quotedShare.id },
      });
      assert.ok(updatedQuotedShare != null);
      await addPostToTimeline(tx, updatedQuotedShare);

      const before = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assert.ok(before != null);
      assert.deepEqual(before.lastSharerId, quotedSharer.actor.id);
      assert.deepEqual(before.sharersCount, 2);

      await removeFromTimeline(tx, followedShare);

      const after = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assert.ok(after != null);
      assert.deepEqual(after.lastSharerId, quotedSharer.actor.id);
      assert.deepEqual(after.sharersCount, 1);
      assert.deepEqual(
        after.appended.toISOString(),
        quotedPublished.toISOString(),
      );
    });
  },
);

test(
  "removeFromTimeline() excludes a share that has not been deleted yet",
  async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const viewer = await insertAccountWithActor(tx, {
        username: "timeliveviewer",
        name: "Timeline Live Viewer",
        email: "timeliveviewer@example.com",
      });
      const firstSharer = await insertAccountWithActor(tx, {
        username: "timelivefirst",
        name: "Timeline Live First",
        email: "timelivefirst@example.com",
      });
      const secondSharer = await insertAccountWithActor(tx, {
        username: "timelivesecond",
        name: "Timeline Live Second",
        email: "timelivesecond@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: `timeliveremote${suffix}`,
        name: "Timeline Live Remote",
        host: "timeline-live.example",
      });
      const originalPost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Shared before its row is deleted</p>",
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
      assert.ok(before != null);
      assert.deepEqual(before.lastSharerId, secondSharer.actor.id);
      assert.deepEqual(before.sharersCount, 2);

      await removeFromTimeline(tx, secondShare);

      const after = await tx.query.timelineItemTable.findFirst({
        where: {
          accountId: viewer.account.id,
          postId: originalPost.id,
        },
      });
      assert.ok(after != null);
      assert.deepEqual(after.lastSharerId, firstSharer.actor.id);
      assert.deepEqual(after.sharersCount, 1);
      assert.deepEqual(
        after.appended.toISOString(),
        firstPublished.toISOString(),
      );
    });
  },
);

test(
  "removeFromTimeline() does not fall back to a sharer the viewer has muted",
  async () => {
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
      assert.deepEqual(after, undefined);
    });
  },
);

test(
  "removeFromTimeline() does not fall back to a sharer whose boost is not visible to the viewer",
  async () => {
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
      assert.deepEqual(after, undefined);
    });
  },
);
