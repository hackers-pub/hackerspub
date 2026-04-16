import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { react, undoReaction } from "./reaction.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name:
    "react() stores a reaction, updates counts, and notifies the post author",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assert(created != null);

      const storedPost = await tx.query.postTable.findFirst({
        where: { id: post.id },
      });
      assert(storedPost != null);
      assertEquals(storedPost.reactionsCounts, { "🎉": 1 });

      const reactions = await tx.query.reactionTable.findMany({
        where: { postId: post.id },
      });
      assertEquals(reactions.length, 1);
      assertEquals(reactions[0].actorId, reactor.actor.id);
      assertEquals(reactions[0].emoji, "🎉");

      const notification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: author.account.id,
          type: "react",
          postId: post.id,
        },
      });
      assert(notification != null);
      assertEquals(notification.actorIds, [reactor.actor.id]);
      assertEquals(notification.emoji, "🎉");
    });
  },
});

Deno.test({
  name: "react() ignores duplicate standard emoji reactions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(duplicate, undefined);

      const reactions = await tx.query.reactionTable.findMany({
        where: { postId: post.id },
      });
      assertEquals(reactions.length, 1);

      const storedPost = await tx.query.postTable.findFirst({
        where: { id: post.id },
      });
      assert(storedPost != null);
      assertEquals(storedPost.reactionsCounts, { "❤️": 1 });
    });
  },
});

Deno.test({
  name: "undoReaction() removes the reaction counts and notification",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assert(removed != null);

      const reactions = await tx.query.reactionTable.findMany({
        where: { postId: post.id },
      });
      assertEquals(reactions, []);

      const storedPost = await tx.query.postTable.findFirst({
        where: { id: post.id },
      });
      assert(storedPost != null);
      assertEquals(storedPost.reactionsCounts, {});

      const notification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: author.account.id,
          type: "react",
          postId: post.id,
        },
      });
      assertEquals(notification, undefined);
    });
  },
});
