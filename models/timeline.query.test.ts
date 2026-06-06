import assert from "node:assert";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { follow } from "./following.ts";
import { mute } from "./muting.ts";
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

test("getPublicTimeline() applies local and withoutShares filters", async () => {
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
    assert.deepEqual(all.map((entry) => entry.post.id), [
      share.id,
      remotePost.id,
      localPost.id,
    ]);

    const localOnly = await getPublicTimeline(tx, {
      local: true,
      window: 10,
    });
    assert.deepEqual(localOnly.map((entry) => entry.post.id), [
      share.id,
      localPost.id,
    ]);

    const localWithoutShares = await getPublicTimeline(tx, {
      local: true,
      withoutShares: true,
      window: 10,
    });
    assert.deepEqual(localWithoutShares.map((entry) => entry.post.id), [
      localPost.id,
    ]);
  });
});

test("getPublicTimeline() uses exclusive cursors without gaps", async () => {
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
    assert.deepEqual(firstPage.map((entry) => entry.post.id), [
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
    assert.deepEqual(secondPage.map((entry) => entry.post.id), [
      orderedPosts[2].id,
      orderedPosts[3].id,
    ]);
  });
});

test("getPublicTimeline() hydrates large windows in bounded batches", async () => {
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
    assert.deepEqual(timeline.length, 300);
    assert.deepEqual(
      timeline.map((entry) => entry.post.id),
      orderedPosts.map((post) => post.id),
    );
  });
});

test("getPersonalTimeline() hides pure shares when withoutShares is enabled", async () => {
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
      published: new Date("2026-04-15T00:00:01.000Z"),
    });

    await follow(fedCtx, viewer.account, sharer.actor);
    const share = await sharePost(fedCtx, sharer.account, {
      ...remotePost,
      actor: remoteActor,
    });
    const sharePublished = new Date("2026-04-15T00:00:04.000Z");

    await tx.update(postTable)
      .set({
        published: sharePublished,
        updated: sharePublished,
      })
      .where(eq(postTable.id, share.id));
    await tx.update(timelineItemTable)
      .set({ appended: sharePublished })
      .where(
        and(
          eq(timelineItemTable.accountId, viewer.account.id),
          eq(timelineItemTable.postId, remotePost.id),
        ),
      );

    const timeline = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(timeline.length, 1);
    assert.deepEqual(timeline[0].post.id, remotePost.id);
    assert.deepEqual(timeline[0].lastSharer?.id, sharer.actor.id);
    assert.deepEqual(timeline[0].sharersCount, 1);
    assert.deepEqual(timeline[0].added, sharePublished);
    assert.deepEqual(timeline[0].cursor, sharePublished);

    const withoutShares = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      withoutShares: true,
      window: 10,
    });
    assert.deepEqual(withoutShares, []);
  });
});

test("getPersonalTimeline() uses appended cursors without gaps", async () => {
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
    assert.deepEqual(firstPage.map((entry) => entry.post.id), [
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
    assert.deepEqual(secondPage.map((entry) => entry.post.id), [
      orderedPosts[2].id,
      orderedPosts[3].id,
    ]);
  });
});

test("getPublicTimeline() filters by base language code with prefix matching", async () => {
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
    assert.deepEqual(
      enOnly.map((e) => e.post.id),
      [enPost.id, enUsPost.id, enGbPost.id],
      "base language 'en' matches 'en', 'en-US', and 'en-GB'",
    );

    const koOnly = await getPublicTimeline(tx, {
      ...scope,
      languages: new Set(["ko"]),
      window: 10,
    });
    assert.deepEqual(
      koOnly.map((e) => e.post.id),
      [koPost.id],
      "base language 'ko' matches only 'ko'",
    );

    const all = await getPublicTimeline(tx, { ...scope, window: 10 });
    const allIds = all.map((e) => e.post.id);
    assert.ok(
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
    assert.deepEqual(
      enUsAsBase.map((e) => e.post.id),
      [enPost.id, enUsPost.id, enGbPost.id],
      "'en-US' normalizes to 'en' and matches all English variants",
    );
  });
});

test("getPersonalTimeline() filters by base language code with prefix matching", async () => {
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
    assert.deepEqual(
      enOnly.map((e) => e.post.id),
      [enPost.id, enGbPost.id],
      "base language 'en' matches both 'en' and 'en-GB'",
    );

    const jaOnly = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      languages: new Set(["ja"]),
      window: 10,
    });
    assert.deepEqual(
      jaOnly.map((e) => e.post.id),
      [jaPost.id],
      "base language 'ja' matches only 'ja'",
    );

    const all = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    const allIds = all.map((e) => e.post.id);
    assert.ok(
      allIds.includes(enPost.id) &&
        allIds.includes(enGbPost.id) &&
        allIds.includes(jaPost.id),
      "empty languages returns all posts",
    );
  });
});

test("getPersonalTimeline() excludes share-only rows from a muted sharer", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const viewer = await insertAccountWithActor(tx, {
      username: "mutesharerviewer",
      name: "Mute Sharer Viewer",
      email: "mutesharerviewer@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "mutesharersharer",
      name: "Mute Sharer Sharer",
      email: "mutesharersharer@example.com",
    });
    const remoteActor = await insertRemoteActor(tx, {
      username: "mutesharerremote",
      name: "Mute Sharer Remote",
      host: "mute-sharer.example",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Boosted by a soon-to-be-muted sharer</p>",
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

    // Before muting, the boosted post is visible (shared by the sharer).
    const before = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(before.map((e) => e.post.id), [remotePost.id]);
    assert.deepEqual(before[0].lastSharer?.id, sharer.actor.id);

    // After muting the sharer, the share-only row disappears entirely.
    await mute(tx, viewer.account, sharer.actor);
    const after = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(after, []);
  });
});

test("getPersonalTimeline() keeps a multi-sharer post attributed to an unmuted sharer after muting the latest sharer", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const viewer = await insertAccountWithActor(tx, {
      username: "multisharerviewer",
      name: "Multi Sharer Viewer",
      email: "multisharerviewer@example.com",
    });
    const sharerA = await insertAccountWithActor(tx, {
      username: "multisharera",
      name: "Multi Sharer A",
      email: "multisharera@example.com",
    });
    const sharerB = await insertAccountWithActor(tx, {
      username: "multisharerb",
      name: "Multi Sharer B",
      email: "multisharerb@example.com",
    });
    const remoteActor = await insertRemoteActor(tx, {
      username: "multisharerremote",
      name: "Multi Sharer Remote",
      host: "multi-sharer.example",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Shared by two followed accounts</p>",
    });

    await follow(fedCtx, viewer.account, sharerA.actor);
    await follow(fedCtx, viewer.account, sharerB.actor);

    // B shares first, then A: A becomes the most recent sharer.
    const shareB = await sharePost(fedCtx, sharerB.account, {
      ...remotePost,
      actor: remoteActor,
    });
    await tx.update(postTable)
      .set({ published: new Date("2026-04-15T00:00:01.000Z") })
      .where(eq(postTable.id, shareB.id));
    const shareA = await sharePost(fedCtx, sharerA.account, {
      ...remotePost,
      actor: remoteActor,
    });
    await tx.update(postTable)
      .set({ published: new Date("2026-04-15T00:00:02.000Z") })
      .where(eq(postTable.id, shareA.id));

    const before = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(before.map((e) => e.post.id), [remotePost.id]);
    assert.deepEqual(before[0].lastSharer?.id, sharerA.actor.id);
    assert.deepEqual(before[0].sharersCount, 2);

    // Muting A keeps the post (B still shared it), re-attributed to B.
    await mute(tx, viewer.account, sharerA.actor);
    const after = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(after.map((e) => e.post.id), [remotePost.id]);
    assert.deepEqual(after[0].lastSharer?.id, sharerB.actor.id);
    assert.deepEqual(after[0].sharersCount, 1);
  });
});

test("getPersonalTimeline() drops a muted non-latest sharer from the count", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const viewer = await insertAccountWithActor(tx, {
      username: "nonlatestviewer",
      name: "Non Latest Viewer",
      email: "nonlatestviewer@example.com",
    });
    const sharerA = await insertAccountWithActor(tx, {
      username: "nonlatesta",
      name: "Non Latest A",
      email: "nonlatesta@example.com",
    });
    const sharerB = await insertAccountWithActor(tx, {
      username: "nonlatestb",
      name: "Non Latest B",
      email: "nonlatestb@example.com",
    });
    const remoteActor = await insertRemoteActor(tx, {
      username: "nonlatestremote",
      name: "Non Latest Remote",
      host: "non-latest.example",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Shared by two followed accounts</p>",
    });

    await follow(fedCtx, viewer.account, sharerA.actor);
    await follow(fedCtx, viewer.account, sharerB.actor);

    // B shares first, then A: A is the most recent sharer, B is not.
    const shareB = await sharePost(fedCtx, sharerB.account, {
      ...remotePost,
      actor: remoteActor,
    });
    await tx.update(postTable)
      .set({ published: new Date("2026-04-15T00:00:01.000Z") })
      .where(eq(postTable.id, shareB.id));
    const shareA = await sharePost(fedCtx, sharerA.account, {
      ...remotePost,
      actor: remoteActor,
    });
    await tx.update(postTable)
      .set({ published: new Date("2026-04-15T00:00:02.000Z") })
      .where(eq(postTable.id, shareA.id));

    // Muting B (the non-latest sharer) leaves the row attributed to A but
    // must drop B from the count rather than leaving it stale.
    await mute(tx, viewer.account, sharerB.actor);
    const after = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(after.map((e) => e.post.id), [remotePost.id]);
    assert.deepEqual(after[0].lastSharer?.id, sharerA.actor.id);
    assert.deepEqual(after[0].sharersCount, 1);
  });
});

test("getPersonalTimeline() excludes a muted actor's boosts made after muting", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const viewer = await insertAccountWithActor(tx, {
      username: "postmuteviewer",
      name: "Post Mute Viewer",
      email: "postmuteviewer@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "postmutesharer",
      name: "Post Mute Sharer",
      email: "postmutesharer@example.com",
    });
    const remoteActor = await insertRemoteActor(tx, {
      username: "postmuteremote",
      name: "Post Mute Remote",
      host: "post-mute.example",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Boosted after the mute</p>",
    });

    // Viewer follows the sharer but mutes them, then the sharer boosts.
    await follow(fedCtx, viewer.account, sharer.actor);
    await mute(tx, viewer.account, sharer.actor);
    const share = await sharePost(fedCtx, sharer.account, {
      ...remotePost,
      actor: remoteActor,
    });
    await tx.update(postTable)
      .set({ published: new Date("2026-04-15T00:00:04.000Z") })
      .where(eq(postTable.id, share.id));

    const timeline = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(timeline, []);
  });
});

test("getPersonalTimeline() excludes posts authored by a muted actor", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const viewer = await insertAccountWithActor(tx, {
      username: "muteauthorviewer",
      name: "Mute Author Viewer",
      email: "muteauthorviewer@example.com",
    });
    const author = await insertAccountWithActor(tx, {
      username: "muteauthorauthor",
      name: "Mute Author Author",
      email: "muteauthorauthor@example.com",
    });
    await follow(fedCtx, viewer.account, author.actor);
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Authored by a soon-to-be-muted actor",
      published: new Date("2026-04-15T00:00:01.000Z"),
    });
    await addPostToTimeline(tx, post);

    const before = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(before.map((e) => e.post.id), [post.id]);

    await mute(tx, viewer.account, author.actor);
    const after = await getPersonalTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(after, []);
  });
});

test("getPublicTimeline() excludes posts authored by a muted actor", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "mutepublicviewer",
      name: "Mute Public Viewer",
      email: "mutepublicviewer@example.com",
    });
    const author = await insertAccountWithActor(tx, {
      username: "mutepublicauthor",
      name: "Mute Public Author",
      email: "mutepublicauthor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Public post by a soon-to-be-muted actor",
      published: new Date("2026-04-15T00:00:01.000Z"),
    });

    const before = await getPublicTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.ok(before.map((e) => e.post.id).includes(post.id));

    await mute(tx, viewer.account, author.actor);
    const after = await getPublicTimeline(tx, {
      currentAccount: viewer.account,
      window: 10,
    });
    assert.deepEqual(after.map((e) => e.post.id).includes(post.id), false);
  });
});
