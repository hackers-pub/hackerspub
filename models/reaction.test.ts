import assert from "node:assert";
import test from "node:test";
import { customEmojiTable, reactionTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import { getViewerReactionsForPosts, react, undoReaction } from "./reaction.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test(
  "react() stores a reaction, updates counts, and notifies the post author",
  async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "authorreact",
        name: "Author React",
        email: "authorreact@example.com",
      });
      const reactor = await insertAccountWithActor(tx, {
        username: "reactor",
        name: "Reactor",
        email: "reactor@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "React to me",
      });

      const created = await react(fedCtx, reactor.account, {
        ...post,
        actor: author.actor,
      }, "🎉");

      assert.ok(created != null);

      const storedPost = await tx.query.postTable.findFirst({
        where: { id: post.id },
      });
      assert.ok(storedPost != null);
      assert.deepEqual(storedPost.reactionsCounts, { "🎉": 1 });

      const reactions = await tx.query.reactionTable.findMany({
        where: { postId: post.id },
      });
      assert.deepEqual(reactions.length, 1);
      assert.deepEqual(reactions[0].actorId, reactor.actor.id);
      assert.deepEqual(reactions[0].emoji, "🎉");

      const notification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: author.account.id,
          type: "react",
          postId: post.id,
        },
      });
      assert.ok(notification != null);
      assert.deepEqual(notification.actorIds, [reactor.actor.id]);
      assert.deepEqual(notification.emoji, "🎉");
    });
  },
);

test("react() ignores duplicate standard emoji reactions", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "dupauthor",
      name: "Dup Author",
      email: "dupauthor@example.com",
    });
    const reactor = await insertAccountWithActor(tx, {
      username: "dupreactor",
      name: "Dup Reactor",
      email: "dupreactor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Duplicate reaction target",
    });

    await react(
      fedCtx,
      reactor.account,
      { ...post, actor: author.actor },
      "❤️",
    );
    const duplicate = await react(
      fedCtx,
      reactor.account,
      { ...post, actor: author.actor },
      "❤️",
    );

    assert.deepEqual(duplicate, undefined);

    const reactions = await tx.query.reactionTable.findMany({
      where: { postId: post.id },
    });
    assert.deepEqual(reactions.length, 1);

    const storedPost = await tx.query.postTable.findFirst({
      where: { id: post.id },
    });
    assert.ok(storedPost != null);
    assert.deepEqual(storedPost.reactionsCounts, { "❤️": 1 });
  });
});

test("undoReaction() removes the reaction counts and notification", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const author = await insertAccountWithActor(tx, {
      username: "undoauthor",
      name: "Undo Author",
      email: "undoauthor@example.com",
    });
    const reactor = await insertAccountWithActor(tx, {
      username: "undoreactor",
      name: "Undo Reactor",
      email: "undoreactor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Undo reaction target",
    });

    await react(
      fedCtx,
      reactor.account,
      { ...post, actor: author.actor },
      "👀",
    );

    const removed = await undoReaction(
      fedCtx,
      reactor.account,
      { ...post, actor: author.actor },
      "👀",
    );

    assert.ok(removed != null);

    const reactions = await tx.query.reactionTable.findMany({
      where: { postId: post.id },
    });
    assert.deepEqual(reactions, []);

    const storedPost = await tx.query.postTable.findFirst({
      where: { id: post.id },
    });
    assert.ok(storedPost != null);
    assert.deepEqual(storedPost.reactionsCounts, {});

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: author.account.id,
        type: "react",
        postId: post.id,
      },
    });
    assert.deepEqual(notification, undefined);
  });
});

test(
  "getViewerReactionsForPosts() returns viewer reactions across post IDs",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "viewerreactionsauthor",
        name: "ViewerReactions Author",
        email: "viewerreactionsauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "viewerreactionsviewer",
        name: "ViewerReactions Viewer",
        email: "viewerreactionsviewer@example.com",
      });
      const other = await insertAccountWithActor(tx, {
        username: "viewerreactionsother",
        name: "ViewerReactions Other",
        email: "viewerreactionsother@example.com",
      });
      const customEmojiId = generateUuidV7();
      await tx.insert(customEmojiTable).values({
        id: customEmojiId,
        iri: `http://localhost/emojis/${customEmojiId}`,
        name: ":party:",
        imageUrl: `https://cdn.example/emoji/${customEmojiId}.png`,
      });

      const { post: postA } = await insertNotePost(tx, {
        account: author.account,
        content: "A",
      });
      const { post: postB } = await insertNotePost(tx, {
        account: author.account,
        content: "B",
      });
      const { post: postC } = await insertNotePost(tx, {
        account: author.account,
        content: "C",
      });

      // Viewer reacts to A with ❤️ and to A with the custom emoji.
      // Viewer reacts to C with 🎉.
      // Other reacts to B with ❤️ — should not appear in viewer's set.
      await tx.insert(reactionTable).values([
        {
          iri: `http://localhost/reactions/${generateUuidV7()}`,
          postId: postA.id,
          actorId: viewer.actor.id,
          emoji: "❤️",
        },
        {
          iri: `http://localhost/reactions/${generateUuidV7()}`,
          postId: postA.id,
          actorId: viewer.actor.id,
          customEmojiId,
        },
        {
          iri: `http://localhost/reactions/${generateUuidV7()}`,
          postId: postC.id,
          actorId: viewer.actor.id,
          emoji: "🎉",
        },
        {
          iri: `http://localhost/reactions/${generateUuidV7()}`,
          postId: postB.id,
          actorId: other.actor.id,
          emoji: "❤️",
        },
      ]);

      const rows = await getViewerReactionsForPosts(
        tx,
        [postA.id, postB.id, postC.id],
        viewer.actor,
      );

      const summary = rows
        .map((r) => ({
          postId: r.postId,
          emoji: r.emoji,
          customEmojiId: r.customEmojiId,
        }))
        .sort((a, b) =>
          `${a.postId}|${a.emoji}|${a.customEmojiId}`
            .localeCompare(`${b.postId}|${b.emoji}|${b.customEmojiId}`)
        );
      const expected = [
        { postId: postA.id, emoji: "❤️", customEmojiId: null },
        { postId: postA.id, emoji: null, customEmojiId },
        { postId: postC.id, emoji: "🎉", customEmojiId: null },
      ].sort((a, b) =>
        `${a.postId}|${a.emoji}|${a.customEmojiId}`
          .localeCompare(`${b.postId}|${b.emoji}|${b.customEmojiId}`)
      );
      assert.deepEqual(summary, expected);
    });
  },
);

test(
  "getViewerReactionsForPosts() returns an empty array for no input",
  async () => {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "viewerreactionsemptyviewer",
        name: "ViewerReactions Empty Viewer",
        email: "viewerreactionsemptyviewer@example.com",
      });

      const rows = await getViewerReactionsForPosts(tx, [], viewer.actor);

      assert.deepEqual(rows, []);
    });
  },
);
