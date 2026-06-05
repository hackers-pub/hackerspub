import { Delete, Note, Update } from "@fedify/vocab";
import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import process from "node:process";
import { follow } from "./following.ts";
import { revokeQuote, sharePost, unsharePost } from "./post.ts";
import {
  followingTable,
  noteSourceTable,
  postTable,
  quoteAuthorizationTable,
} from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

test("sharePost() creates a share, timeline entry, and notification", async () => {
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

    assert.deepEqual(share.sharedPostId, originalPost.id);

    const storedOriginal = await tx.query.postTable.findFirst({
      where: { id: originalPost.id },
    });
    assert.ok(storedOriginal != null);
    assert.deepEqual(storedOriginal.sharesCount, 1);

    const timelineItem = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: follower.account.id,
        postId: originalPost.id,
      },
    });
    assert.ok(timelineItem != null);
    assert.deepEqual(timelineItem.originalAuthorId, null);
    assert.deepEqual(timelineItem.lastSharerId, sharer.actor.id);
    assert.deepEqual(timelineItem.sharersCount, 1);

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: author.account.id,
        type: "share",
        postId: originalPost.id,
      },
    });
    assert.ok(notification != null);
    assert.deepEqual(notification.actorIds, [sharer.actor.id]);
  });
});

test("sharePost() is idempotent for duplicate shares", async () => {
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

    assert.deepEqual(second.id, first.id);

    const shares = await tx.query.postTable.findMany({
      where: {
        actorId: sharer.actor.id,
        sharedPostId: originalPost.id,
      },
    });
    assert.deepEqual(shares.length, 1);

    const storedOriginal = await tx.query.postTable.findFirst({
      where: { id: originalPost.id },
    });
    assert.ok(storedOriginal != null);
    assert.deepEqual(storedOriginal.sharesCount, 1);
  });
});

test("unsharePost() removes the share, timeline entry, and notification", async () => {
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

    assert.ok(removed != null);

    const shares = await tx.select().from(postTable).where(and(
      eq(postTable.actorId, sharer.actor.id),
      eq(postTable.sharedPostId, originalPost.id),
    ));
    assert.deepEqual(shares, []);

    const storedOriginal = await tx.query.postTable.findFirst({
      where: { id: originalPost.id },
    });
    assert.ok(storedOriginal != null);
    assert.deepEqual(storedOriginal.sharesCount, 0);

    const timelineItem = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: follower.account.id,
        postId: originalPost.id,
      },
    });
    assert.deepEqual(timelineItem, undefined);

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: author.account.id,
        type: "share",
        postId: originalPost.id,
      },
    });
    assert.deepEqual(notification, undefined);
  });
});

test("revokeQuote() federates an Update for locally authored quotes", async () => {
  await withTagsPubRelayEnabled(async () => {
    await withRollback(async (tx) => {
      const owner = await insertAccountWithActor(tx, {
        username: "quoterevokeowner",
        name: "Quote Revoke Owner",
        email: "quoterevokeowner@example.com",
      });
      const quoter = await insertAccountWithActor(tx, {
        username: "quoterevokelocal",
        name: "Quote Revoke Local",
        email: "quoterevokelocal@example.com",
      });
      const remoteFollower = await insertRemoteActor(tx, {
        username: "quoterevokefollower",
        name: "Quote Revoke Follower",
        host: "remote.example",
      });
      await tx.insert(followingTable).values({
        iri: `https://remote.example/follows/${remoteFollower.id}`,
        followerId: remoteFollower.id,
        followeeId: quoter.actor.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
      const { post: quotedPost } = await insertNotePost(tx, {
        account: owner.account,
        content: "Quote revocation target",
      });
      const { post: quote } = await insertNotePost(tx, {
        account: quoter.account,
        content: "Quote that will be revoked #Fediverse",
        quotedPostId: quotedPost.id,
      });
      assert.ok(quote.noteSourceId != null);
      const authorizationIri = `${quote.iri}#quote-authorization`;
      await tx.update(postTable)
        .set({
          quoteAuthorizationIri: authorizationIri,
          relayedTags: ["fediverse"],
        })
        .where(eq(postTable.id, quote.id));
      await tx.insert(quoteAuthorizationTable).values({
        id: quote.id,
        iri: authorizationIri,
        quotePostIri: quote.iri,
        quotePostId: quote.id,
        quotedPostId: quotedPost.id,
        attributedActorId: owner.actor.id,
      });
      // Pin updated to epoch so revokeQuote's new Date() is always strictly
      // greater, regardless of how fast the test runs.
      await tx.update(noteSourceTable)
        .set({ updated: new Date(0) })
        .where(eq(noteSourceTable.id, quote.noteSourceId));
      const originalSource = await tx.query.noteSourceTable.findFirst({
        where: { id: quote.noteSourceId },
      });
      assert.ok(originalSource != null);
      const sent: unknown[][] = [];
      const fedCtx = {
        ...createFedCtx(tx),
        sendActivity(...args: unknown[]) {
          sent.push(args);
          return Promise.resolve(undefined);
        },
      };
      const quoteWithActor = await tx.query.postTable.findFirst({
        where: { id: quote.id },
        with: { actor: true },
      });
      assert.ok(quoteWithActor != null);

      await revokeQuote(
        fedCtx,
        owner.account,
        quoteWithActor,
        quotedPost,
      );

      const storedQuote = await tx.query.postTable.findFirst({
        where: { id: quote.id },
      });
      assert.ok(storedQuote != null);
      assert.deepEqual(storedQuote.quotedPostId, null);
      assert.deepEqual(storedQuote.quoteAuthorizationIri, null);
      assert.deepEqual(storedQuote.quoteTargetState, "denied");
      const updatedSource = await tx.query.noteSourceTable.findFirst({
        where: { id: quote.noteSourceId },
      });
      assert.ok(updatedSource != null);
      assert.ok(updatedSource.updated > originalSource.updated);
      const authorization = await tx.query.quoteAuthorizationTable.findFirst({
        where: { iri: authorizationIri },
      });
      assert.deepEqual(authorization?.revoked, true);

      const update = sent
        .map((args) => args[2])
        .find((activity) => activity instanceof Update);
      assert.ok(update instanceof Update);
      const updatedObject = await update.getObject({
        ...fedCtx,
        suppressError: true,
      });
      assert.ok(updatedObject instanceof Note);
      assert.deepEqual(updatedObject.quoteId, null);
      assert.deepEqual(updatedObject.quoteAuthorizationId, null);
      const del = sent
        .map((args) => args[2])
        .find((activity) => activity instanceof Delete);
      assert.ok(del instanceof Delete);
      assert.deepEqual(del.objectId?.href, authorizationIri);
      assert.ok(
        sent.some((args) =>
          args[2] instanceof Delete &&
          Array.isArray(args[1]) &&
          args[1].some((recipient) =>
            recipient != null &&
            typeof recipient === "object" &&
            "id" in recipient &&
            recipient.id instanceof URL &&
            recipient.id.href === remoteFollower.iri
          )
        ),
      );
      assert.ok(
        sent.some((args) =>
          args[2] instanceof Update &&
          args[1] != null &&
          typeof args[1] === "object" &&
          "id" in args[1] &&
          args[1].id instanceof URL &&
          args[1].id.href === "https://tags.pub/user/_____relay_____"
        ),
      );
    });
  });
});

test("revokeQuote() does not double-decrement retried revocations", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "quoterevokeidemowner",
      name: "Quote Revoke Idempotent Owner",
      email: "quoterevokeidemowner@example.com",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoterevokeidemlocal",
      name: "Quote Revoke Idempotent Local",
      email: "quoterevokeidemlocal@example.com",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: owner.account,
      content: "Idempotent quote revocation target",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Quote revoked twice",
      quotedPostId: quotedPost.id,
    });
    await tx.update(postTable)
      .set({ quotesCount: 1 })
      .where(eq(postTable.id, quotedPost.id));
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity() {
        return Promise.resolve(undefined);
      },
    };
    const quoteWithActor = await tx.query.postTable.findFirst({
      where: { id: quote.id },
      with: { actor: true },
    });
    assert.ok(quoteWithActor != null);

    await revokeQuote(fedCtx, owner.account, quoteWithActor, quotedPost);
    const secondResult = await revokeQuote(
      fedCtx,
      owner.account,
      quoteWithActor,
      quotedPost,
    );
    assert.deepEqual(secondResult.quotedPostId, null);

    const storedTarget = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.deepEqual(storedTarget?.quotesCount, 0);
  });
});

async function withTagsPubRelayEnabled(
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env.TAGS_PUB_RELAY;
  process.env.TAGS_PUB_RELAY = "true";
  try {
    await run();
  } finally {
    if (previous == null) {
      delete process.env.TAGS_PUB_RELAY;
    } else {
      process.env.TAGS_PUB_RELAY = previous;
    }
  }
}
