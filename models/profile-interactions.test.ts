import assert from "node:assert";
import test from "node:test";
import { sql } from "drizzle-orm";
import { block } from "./blocking.ts";
import { sharePost } from "./post.ts";
import {
  formatTimelineCursor,
  getProfileInteractions,
} from "./profile-interactions.ts";
import { postTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertMention,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("getProfileInteractions() returns direct bidirectional replies, quotes, and mentions newest first", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "interactionviewer",
      name: "Interaction Viewer",
      email: "interactionviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "interactionprofile",
      name: "Interaction Profile",
      email: "interactionprofile@example.com",
    });
    const thirdParty = await insertAccountWithActor(tx, {
      username: "interactionthird",
      name: "Interaction Third",
      email: "interactionthird@example.com",
    });

    const { post: viewerRoot } = await insertNotePost(tx, {
      account: viewer.account,
      content: "Viewer root",
      published: new Date("2026-04-15T00:00:00.000Z"),
    });
    const { post: profileRoot } = await insertNotePost(tx, {
      account: profile.account,
      content: "Profile root",
      published: new Date("2026-04-15T00:00:01.000Z"),
    });
    const { post: viewerMention } = await insertNotePost(tx, {
      account: viewer.account,
      content: "Viewer mentions profile",
      published: new Date("2026-04-15T00:00:02.000Z"),
    });
    await insertMention(tx, {
      postId: viewerMention.id,
      actorId: profile.actor.id,
    });
    const { post: profileReply } = await insertNotePost(tx, {
      account: profile.account,
      content: "Profile replies to viewer",
      replyTargetId: viewerRoot.id,
      published: new Date("2026-04-15T00:00:03.000Z"),
    });
    const { post: profileQuote } = await insertNotePost(tx, {
      account: profile.account,
      content: "Profile quotes viewer",
      quotedPostId: viewerRoot.id,
      published: new Date("2026-04-15T00:00:04.000Z"),
    });
    const { post: profileMention } = await insertNotePost(tx, {
      account: profile.account,
      content: "Profile mentions viewer",
      published: new Date("2026-04-15T00:00:05.000Z"),
    });
    await insertMention(tx, {
      postId: profileMention.id,
      actorId: viewer.actor.id,
    });
    const { post: thirdPartyMention } = await insertNotePost(tx, {
      account: thirdParty.account,
      content: "Third party mentions both",
      published: new Date("2026-04-15T00:00:06.000Z"),
    });
    await insertMention(tx, {
      postId: thirdPartyMention.id,
      actorId: viewer.actor.id,
    });
    await insertMention(tx, {
      postId: thirdPartyMention.id,
      actorId: profile.actor.id,
    });
    await sharePost(createFedCtx(tx), viewer.account, {
      ...profileRoot,
      actor: profile.actor,
    });

    const interactions = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: profile.actor.id,
      window: 10,
    });

    assert.deepEqual(interactions.map((entry) => entry.post.id), [
      profileMention.id,
      profileQuote.id,
      profileReply.id,
      viewerMention.id,
    ]);
  });
});

test("getProfileInteractions() applies viewer visibility and self-profile rules", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "interactionvisibleviewer",
      name: "Interaction Visible Viewer",
      email: "interactionvisibleviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "interactionvisibleprofile",
      name: "Interaction Visible Profile",
      email: "interactionvisibleprofile@example.com",
    });
    const { post: hiddenProfileMention } = await insertNotePost(tx, {
      account: profile.account,
      content: "Hidden profile mention",
      visibility: "followers",
      published: new Date("2026-04-15T00:00:01.000Z"),
    });
    await insertMention(tx, {
      postId: hiddenProfileMention.id,
      actorId: viewer.actor.id,
    });
    const { post: visibleProfileMention } = await insertNotePost(tx, {
      account: profile.account,
      content: "Visible profile mention",
      visibility: "public",
      published: new Date("2026-04-15T00:00:02.000Z"),
    });
    await insertMention(tx, {
      postId: visibleProfileMention.id,
      actorId: viewer.actor.id,
    });

    const interactions = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: profile.actor.id,
      window: 10,
    });
    assert.deepEqual(interactions.map((entry) => entry.post.id), [
      visibleProfileMention.id,
      hiddenProfileMention.id,
    ]);

    const selfInteractions = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: viewer.actor.id,
      window: 10,
    });
    assert.deepEqual(selfInteractions, []);
  });
});

test("getProfileInteractions() excludes blocked profile relationships", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "interactionblockviewer",
      name: "Interaction Block Viewer",
      email: "interactionblockviewer@example.com",
    });
    const blockedProfile = await insertAccountWithActor(tx, {
      username: "interactionblockedprofile",
      name: "Interaction Blocked Profile",
      email: "interactionblockedprofile@example.com",
    });
    const blockerProfile = await insertAccountWithActor(tx, {
      username: "interactionblockerprofile",
      name: "Interaction Blocker Profile",
      email: "interactionblockerprofile@example.com",
    });

    const { post: blockedMention } = await insertNotePost(tx, {
      account: viewer.account,
      content: "Viewer mentions a blocked profile",
      published: new Date("2026-04-15T00:00:01.000Z"),
    });
    await insertMention(tx, {
      postId: blockedMention.id,
      actorId: blockedProfile.actor.id,
    });
    await block(createFedCtx(tx), viewer.account, blockedProfile.actor);

    const { post: blockerMention } = await insertNotePost(tx, {
      account: viewer.account,
      content: "Viewer mentions a profile that blocked them",
      published: new Date("2026-04-15T00:00:02.000Z"),
    });
    await insertMention(tx, {
      postId: blockerMention.id,
      actorId: blockerProfile.actor.id,
    });
    await block(createFedCtx(tx), blockerProfile.account, viewer.actor);

    const blockedInteractions = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: blockedProfile.actor.id,
      window: 10,
    });
    assert.deepEqual(blockedInteractions, []);

    const blockerInteractions = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: blockerProfile.actor.id,
      window: 10,
    });
    assert.deepEqual(blockerInteractions, []);
  });
});

test("getProfileInteractions() supports stable cursor pagination", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "interactionpageviewer",
      name: "Interaction Page Viewer",
      email: "interactionpageviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "interactionpageprofile",
      name: "Interaction Page Profile",
      email: "interactionpageprofile@example.com",
    });
    const timestamp = new Date("2026-04-15T00:00:01.000Z");
    const posts = [];
    for (let i = 0; i < 4; i++) {
      const { post } = await insertNotePost(tx, {
        account: i % 2 === 0 ? viewer.account : profile.account,
        content: `Interaction page ${i}`,
        published: timestamp,
      });
      await insertMention(tx, {
        postId: post.id,
        actorId: i % 2 === 0 ? profile.actor.id : viewer.actor.id,
      });
      posts.push(post);
    }
    const orderedPosts = [...posts].sort((a, b) => b.id.localeCompare(a.id));

    const firstPage = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: profile.actor.id,
      window: 2,
    });
    assert.deepEqual(firstPage.map((entry) => entry.post.id), [
      orderedPosts[0].id,
      orderedPosts[1].id,
    ]);

    const secondPage = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: profile.actor.id,
      until: {
        timestamp: firstPage[1].cursor,
        postId: firstPage[1].post.id,
      },
      window: 2,
    });
    assert.deepEqual(secondPage.map((entry) => entry.post.id), [
      orderedPosts[2].id,
      orderedPosts[3].id,
    ]);

    assert.equal(
      formatTimelineCursor(firstPage[0]),
      `${timestamp.toISOString()}|${firstPage[0].post.id}`,
    );
  });
});

test("getProfileInteractions() keeps cursor order stable for sub-millisecond timestamps", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "interactionmicroviewer",
      name: "Interaction Micro Viewer",
      email: "interactionmicroviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "interactionmicroprofile",
      name: "Interaction Micro Profile",
      email: "interactionmicroprofile@example.com",
    });

    const { post: higherMicrosecond } = await insertNotePost(tx, {
      account: viewer.account,
      content: "Higher microsecond",
    });
    await insertMention(tx, {
      postId: higherMicrosecond.id,
      actorId: profile.actor.id,
    });
    const { post: lowerMicrosecond } = await insertNotePost(tx, {
      account: profile.account,
      content: "Lower microsecond",
    });
    await insertMention(tx, {
      postId: lowerMicrosecond.id,
      actorId: viewer.actor.id,
    });

    await tx.execute(
      sql`update ${postTable}
          set published = '2026-04-15T00:00:00.000400Z'
          where id = ${higherMicrosecond.id}`,
    );
    await tx.execute(
      sql`update ${postTable}
          set published = '2026-04-15T00:00:00.000300Z'
          where id = ${lowerMicrosecond.id}`,
    );

    const orderedPosts = [higherMicrosecond, lowerMicrosecond]
      .sort((a, b) => b.id.localeCompare(a.id));
    const firstPage = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: profile.actor.id,
      window: 1,
    });
    assert.deepEqual(firstPage.map((entry) => entry.post.id), [
      orderedPosts[0].id,
    ]);

    const secondPage = await getProfileInteractions(tx, {
      viewer: viewer.account,
      profileActorId: profile.actor.id,
      until: {
        timestamp: firstPage[0].cursor,
        postId: firstPage[0].post.id,
      },
      window: 1,
    });
    assert.deepEqual(secondPage.map((entry) => entry.post.id), [
      orderedPosts[1].id,
    ]);
  });
});
