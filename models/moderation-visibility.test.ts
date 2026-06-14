import assert from "node:assert";
import { describe, it } from "node:test";
import {
  getCensoredPostExclusionFilter,
  getPostVisibilityFilter,
  getPublicTimelineVisibilityFilter,
} from "@hackerspub/models/post";
import { actorTable, type Post, postTable } from "@hackerspub/models/schema";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import { eq, sql } from "drizzle-orm";
import type { RelationsFilter, Transaction } from "@hackerspub/models/db";
import {
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

const HOUR = 60 * 60 * 1000;

async function visiblePostIds(
  tx: Transaction,
  filter: RelationsFilter<"postTable">,
): Promise<Set<Uuid>> {
  const posts = await tx.query.postTable.findMany({
    where: filter,
    columns: { id: true },
  });
  return new Set(posts.map((p) => p.id));
}

async function insertShareOf(
  tx: Transaction,
  sharerActorId: Uuid,
  sharedPost: Post,
): Promise<Post> {
  const id = generateUuidV7();
  await tx.insert(postTable).values({
    id,
    iri: `http://localhost/shares/${id}`,
    type: sharedPost.type,
    visibility: "public",
    actorId: sharerActorId,
    sharedPostId: sharedPost.id,
    contentHtml: sharedPost.contentHtml,
  });
  const share = await tx.query.postTable.findFirst({ where: { id } });
  assert.ok(share != null);
  return share;
}

describe("getCensoredPostExclusionFilter()", () => {
  it("hides censored posts from everyone but the author", async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "author",
        name: "Author",
        email: "author@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "viewer",
        name: "Viewer",
        email: "viewer@example.com",
      });
      const { post } = await insertNotePost(tx, { account: author.account });
      await tx.update(postTable)
        .set({ censored: sql`CURRENT_TIMESTAMP` })
        .where(eq(postTable.id, post.id));
      const guestVisible = await visiblePostIds(
        tx,
        getCensoredPostExclusionFilter(null),
      );
      assert.ok(!guestVisible.has(post.id));
      const viewerVisible = await visiblePostIds(
        tx,
        getCensoredPostExclusionFilter(viewer.actor.id),
      );
      assert.ok(!viewerVisible.has(post.id));
      const authorVisible = await visiblePostIds(
        tx,
        getCensoredPostExclusionFilter(author.actor.id),
      );
      assert.ok(authorVisible.has(post.id));
    });
  });

  it("hides boosts of censored posts", async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "author",
        name: "Author",
        email: "author@example.com",
      });
      const booster = await insertAccountWithActor(tx, {
        username: "booster",
        name: "Booster",
        email: "booster@example.com",
      });
      const { post } = await insertNotePost(tx, { account: author.account });
      const share = await insertShareOf(tx, booster.actor.id, post);
      await tx.update(postTable)
        .set({ censored: sql`CURRENT_TIMESTAMP` })
        .where(eq(postTable.id, post.id));
      const visible = await visiblePostIds(
        tx,
        getCensoredPostExclusionFilter(null),
      );
      assert.ok(!visible.has(share.id));
    });
  });

  it("keeps uncensored posts visible", async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "author",
        name: "Author",
        email: "author@example.com",
      });
      const { post } = await insertNotePost(tx, { account: author.account });
      const visible = await visiblePostIds(
        tx,
        getCensoredPostExclusionFilter(null),
      );
      assert.ok(visible.has(post.id));
    });
  });
});

describe("sanctioned actor content hiding", () => {
  it("keeps unsanctioned actors' posts visible (NULL-safe baseline)", async () => {
    await withRollback(async (tx) => {
      const local = await insertAccountWithActor(tx, {
        username: "author",
        name: "Author",
        email: "author@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "viewer",
        name: "Viewer",
        email: "viewer@example.com",
      });
      const remote = await insertRemoteActor(tx, {
        username: "remoteok",
        name: "Remote",
        host: "remote.example",
      });
      const { post: localPost } = await insertNotePost(tx, {
        account: local.account,
      });
      const remotePost = await insertRemotePost(tx, { actorId: remote.id });
      for (
        const filter of [
          getPostVisibilityFilter(null),
          getPostVisibilityFilter(viewer.actor),
          getPublicTimelineVisibilityFilter(null),
          getPublicTimelineVisibilityFilter(viewer.actor),
        ]
      ) {
        const visible = await visiblePostIds(tx, filter);
        assert.ok(visible.has(localPost.id));
        assert.ok(visible.has(remotePost.id));
      }
    });
  });

  it("hides a banned local actor's posts from everyone", async () => {
    await withRollback(async (tx) => {
      const banned = await insertAccountWithActor(tx, {
        username: "banned",
        name: "Banned",
        email: "banned@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "viewer",
        name: "Viewer",
        email: "viewer@example.com",
      });
      const { post } = await insertNotePost(tx, { account: banned.account });
      await tx.update(actorTable)
        .set({ suspended: new Date(Date.now() - HOUR) })
        .where(eq(actorTable.id, banned.actor.id));
      const guestVisible = await visiblePostIds(
        tx,
        getPostVisibilityFilter(null),
      );
      assert.ok(!guestVisible.has(post.id));
      const viewerVisible = await visiblePostIds(
        tx,
        getPostVisibilityFilter(viewer.actor),
      );
      assert.ok(!viewerVisible.has(post.id));
      const publicTimelineVisible = await visiblePostIds(
        tx,
        getPublicTimelineVisibilityFilter(null),
      );
      assert.ok(!publicTimelineVisible.has(post.id));
    });
  });

  it("keeps a temporarily suspended local actor's posts visible", async () => {
    await withRollback(async (tx) => {
      const suspended = await insertAccountWithActor(tx, {
        username: "suspended",
        name: "Suspended",
        email: "suspended@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: suspended.account,
      });
      await tx.update(actorTable)
        .set({
          suspended: new Date(Date.now() - HOUR),
          suspendedUntil: new Date(Date.now() + HOUR),
        })
        .where(eq(actorTable.id, suspended.actor.id));
      const guestVisible = await visiblePostIds(
        tx,
        getPostVisibilityFilter(null),
      );
      assert.ok(guestVisible.has(post.id));
    });
  });

  it("hides a temporarily suspended remote actor's posts", async () => {
    await withRollback(async (tx) => {
      const remote = await insertRemoteActor(tx, {
        username: "troll",
        name: "Troll",
        host: "remote.example",
      });
      const post = await insertRemotePost(tx, { actorId: remote.id });
      await tx.update(actorTable)
        .set({
          suspended: new Date(Date.now() - HOUR),
          suspendedUntil: new Date(Date.now() + HOUR),
        })
        .where(eq(actorTable.id, remote.id));
      const guestVisible = await visiblePostIds(
        tx,
        getPostVisibilityFilter(null),
      );
      assert.ok(!guestVisible.has(post.id));
    });
  });

  it("treats an expired suspension as no sanction", async () => {
    await withRollback(async (tx) => {
      const remote = await insertRemoteActor(tx, {
        username: "reformed",
        name: "Reformed",
        host: "remote.example",
      });
      const post = await insertRemotePost(tx, { actorId: remote.id });
      await tx.update(actorTable)
        .set({
          suspended: new Date(Date.now() - 2 * HOUR),
          suspendedUntil: new Date(Date.now() - HOUR),
        })
        .where(eq(actorTable.id, remote.id));
      const guestVisible = await visiblePostIds(
        tx,
        getPostVisibilityFilter(null),
      );
      assert.ok(guestVisible.has(post.id));
    });
  });

  it("treats a not-yet-started suspension as no sanction", async () => {
    await withRollback(async (tx) => {
      const remote = await insertRemoteActor(tx, {
        username: "future",
        name: "Future",
        host: "remote.example",
      });
      const post = await insertRemotePost(tx, { actorId: remote.id });
      await tx.update(actorTable)
        .set({
          suspended: new Date(Date.now() + HOUR),
          suspendedUntil: new Date(Date.now() + 2 * HOUR),
        })
        .where(eq(actorTable.id, remote.id));
      const guestVisible = await visiblePostIds(
        tx,
        getPostVisibilityFilter(null),
      );
      assert.ok(guestVisible.has(post.id));
    });
  });

  it("hides boosts of a banned actor's posts", async () => {
    await withRollback(async (tx) => {
      const banned = await insertAccountWithActor(tx, {
        username: "banned",
        name: "Banned",
        email: "banned@example.com",
      });
      const booster = await insertAccountWithActor(tx, {
        username: "booster",
        name: "Booster",
        email: "booster@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "viewer",
        name: "Viewer",
        email: "viewer@example.com",
      });
      const { post } = await insertNotePost(tx, { account: banned.account });
      const share = await insertShareOf(tx, booster.actor.id, post);
      await tx.update(actorTable)
        .set({ suspended: new Date(Date.now() - HOUR) })
        .where(eq(actorTable.id, banned.actor.id));
      const guestVisible = await visiblePostIds(
        tx,
        getPostVisibilityFilter(null),
      );
      assert.ok(!guestVisible.has(share.id));
      const viewerVisible = await visiblePostIds(
        tx,
        getPostVisibilityFilter(viewer.actor),
      );
      assert.ok(!viewerVisible.has(share.id));
    });
  });
});
