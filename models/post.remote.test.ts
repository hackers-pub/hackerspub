import assert from "node:assert/strict";
import test from "node:test";
import {
  InteractionPolicy,
  InteractionRule,
  Note,
  PUBLIC_COLLECTION,
} from "@fedify/vocab";
import { eq } from "drizzle-orm";
import {
  deletePersistedPost,
  deleteSharedPost,
  getPostByUsernameAndId,
  persistPost,
} from "./post.ts";
import { actorTable, postTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

test("getPostByUsernameAndId() requires a full handle and returns a matching post", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "getpostowner",
      name: "Get Post Owner",
      email: "getpostowner@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: account.account,
      content: "Lookup by handle",
    });

    assert.equal(
      await getPostByUsernameAndId(
        tx,
        account.account.username,
        post.id,
        account.account,
      ),
      undefined,
    );

    const found = await getPostByUsernameAndId(
      tx,
      `${account.account.username}@localhost`,
      post.id,
      account.account,
    );

    assert.ok(found != null);
    assert.equal(found.id, post.id);
    assert.equal(found.actor.id, account.actor.id);
  });
});

test("deletePersistedPost() removes a remote reply and decrements the parent reply count", async () => {
  await withRollback(async (tx) => {
    const remoteAuthorSuffix = crypto.randomUUID().replaceAll("-", "").slice(
      0,
      8,
    );
    const remoteActor = await insertRemoteActor(tx, {
      username: `remoteauthor${remoteAuthorSuffix}`,
      name: "Remote Author",
      host: "remote.example",
    });
    const parent = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Remote parent</p>",
    });
    const reply = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Remote reply</p>",
      replyTargetId: parent.id,
    });
    await tx.update(postTable)
      .set({ repliesCount: 1 })
      .where(eq(postTable.id, parent.id));

    const deleted = await deletePersistedPost(
      tx,
      new URL(reply.iri),
      new URL(remoteActor.iri),
    );

    assert.equal(deleted, true);
    const remainingReply = await tx.query.postTable.findFirst({
      where: { id: reply.id },
    });
    assert.equal(remainingReply, undefined);

    const updatedParent = await tx.query.postTable.findFirst({
      where: { id: parent.id },
    });
    assert.ok(updatedParent != null);
    assert.equal(updatedParent.repliesCount, 0);
  });
});

test("deleteSharedPost() removes a remote share and decrements the target share count", async () => {
  await withRollback(async (tx) => {
    const remoteSharerSuffix = crypto.randomUUID().replaceAll("-", "").slice(
      0,
      8,
    );
    const remoteActor = await insertRemoteActor(tx, {
      username: `remotesharer${remoteSharerSuffix}`,
      name: "Remote Sharer",
      host: "remote.example",
    });
    const original = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Original remote post</p>",
    });
    const share = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Shared remote post</p>",
      sharedPostId: original.id,
    });
    await tx.update(postTable)
      .set({ sharesCount: 1 })
      .where(eq(postTable.id, original.id));

    const deletedShare = await deleteSharedPost(
      tx,
      new URL(share.iri),
      new URL(remoteActor.iri),
    );

    assert.ok(deletedShare != null);
    assert.equal(deletedShare.id, share.id);
    assert.equal(deletedShare.actor.id, remoteActor.id);

    const remainingShare = await tx.query.postTable.findFirst({
      where: { id: share.id },
    });
    assert.equal(remainingShare, undefined);

    const updatedOriginal = await tx.query.postTable.findFirst({
      where: { id: original.id },
    });
    assert.ok(updatedOriginal != null);
    assert.equal(updatedOriginal.sharesCount, 0);
  });
});

test("persistPost() stores manual quote request policies separately", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "manualquotepersist",
      name: "Manual Quote Persist",
      host: "remote.example",
    });
    const post = new Note({
      id: new URL("https://remote.example/objects/manual-quote-policy"),
      attribution: new URL(remoteActor.iri),
      to: PUBLIC_COLLECTION,
      content: "Manual quote policy",
      interactionPolicy: new InteractionPolicy({
        canQuote: new InteractionRule({
          manualApproval: PUBLIC_COLLECTION,
        }),
      }),
    });

    const persisted = await persistPost(createFedCtx(tx), post);

    assert.ok(persisted != null);
    assert.equal(persisted.quotePolicy, "self");
    assert.equal(persisted.quoteRequestPolicy, "everyone");
  });
});

test("persistPost() requires follower quote approvals to match the author", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quotefollowerspolicy",
      name: "Quote Followers Policy",
      host: "remote.example",
    });
    await tx.update(actorTable)
      .set({ followersUrl: "https://remote.example/users/author/followers" })
      .where(eq(actorTable.id, remoteActor.id));
    const post = new Note({
      id: new URL("https://remote.example/objects/wrong-followers-policy"),
      attribution: new URL(remoteActor.iri),
      to: PUBLIC_COLLECTION,
      content: "Wrong followers policy",
      interactionPolicy: new InteractionPolicy({
        canQuote: new InteractionRule({
          automaticApproval: new URL("https://remote.example/groups/followers"),
        }),
      }),
    });

    const persisted = await persistPost(createFedCtx(tx), post);

    assert.ok(persisted != null);
    assert.equal(persisted.quotePolicy, "self");
    assert.equal(persisted.quoteRequestPolicy, null);
  });
});

test("persistPost() accepts the author's followers quote approval", async () => {
  await withRollback(async (tx) => {
    const followersUrl = "https://remote.example/users/author/followers";
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoteauthorfollowers",
      name: "Quote Author Followers",
      host: "remote.example",
    });
    await tx.update(actorTable)
      .set({ followersUrl })
      .where(eq(actorTable.id, remoteActor.id));
    const post = new Note({
      id: new URL("https://remote.example/objects/author-followers-policy"),
      attribution: new URL(remoteActor.iri),
      to: PUBLIC_COLLECTION,
      content: "Author followers policy",
      interactionPolicy: new InteractionPolicy({
        canQuote: new InteractionRule({
          automaticApproval: new URL(followersUrl),
        }),
      }),
    });

    const persisted = await persistPost(createFedCtx(tx), post);

    assert.ok(persisted != null);
    assert.equal(persisted.quotePolicy, "followers");
    assert.equal(persisted.quoteRequestPolicy, null);
  });
});

test("persistPost() clears stale quote targets denied by policy", async () => {
  await withRollback(async (tx) => {
    const quoter = await insertRemoteActor(tx, {
      username: "stalequotequoter",
      name: "Stale Quote Quoter",
      host: "remote.example",
    });
    const quotedAuthor = await insertRemoteActor(tx, {
      username: "stalequoteauthor",
      name: "Stale Quote Author",
      host: "quoted.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: quotedAuthor.id,
      contentHtml: "<p>Restricted quoted post</p>",
      quotePolicy: "self",
    });
    const existingQuote = await insertRemotePost(tx, {
      actorId: quoter.id,
      contentHtml: "<p>Previously allowed quote</p>",
      quotedPostId: quotedPost.id,
    });
    await tx.update(postTable)
      .set({ quotesCount: 1 })
      .where(eq(postTable.id, quotedPost.id));
    const refetchedQuote = new Note({
      id: new URL(existingQuote.iri),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Previously allowed quote",
      quote: new URL(quotedPost.iri),
    });

    const persisted = await persistPost(createFedCtx(tx), refetchedQuote);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost, null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: existingQuote.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, null);
    assert.equal(storedQuote.quoteAuthorizationIri, null);
    const storedQuotedPost = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.ok(storedQuotedPost != null);
    assert.equal(storedQuotedPost.quotesCount, 0);
  });
});
