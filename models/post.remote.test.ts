import assert from "node:assert/strict";
import test from "node:test";
import {
  InteractionPolicy,
  InteractionRule,
  Note,
  PUBLIC_COLLECTION,
  QuoteAuthorization,
} from "@fedify/vocab";
import { eq } from "drizzle-orm";
import {
  deletePersistedPost,
  deleteSharedPost,
  getAllowedQuoteTargetForActor,
  getPostByUsernameAndId,
  persistPost,
} from "./post.ts";
import {
  actorTable,
  postTable,
  quoteAuthorizationTable,
  quoteRequestTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
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

test("persistPost() notifies local sharers when a remote body changes", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "remoteshareupdateauthor",
      name: "Remote Share Update Author",
      host: "remote.example",
    });
    const localSharer = await insertAccountWithActor(tx, {
      username: "remoteshareupdatesharer",
      name: "Remote Share Update Sharer",
      email: "remoteshareupdatesharer@example.com",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Original remote shared body</p>",
    });
    await insertNotePost(tx, {
      account: localSharer.account,
      content: "",
      sharedPostId: remotePost.id,
    });
    const refetched = new Note({
      id: new URL(remotePost.iri),
      attribution: new URL(remoteActor.iri),
      to: PUBLIC_COLLECTION,
      content: "Updated remote shared body",
    });

    await persistPost(createFedCtx(tx), refetched);

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: localSharer.account.id,
        type: "shared_post_updated",
        postId: remotePost.id,
      },
    });
    assert.ok(notification != null);
    assert.deepEqual(notification.actorIds, [remoteActor.id]);
  });
});

test("persistPost() notifies pending local quoters when a remote body changes", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "remotequoteupdateauthor",
      name: "Remote Quote Update Author",
      host: "remote.example",
    });
    const localQuoter = await insertAccountWithActor(tx, {
      username: "remotequoteupdatequoter",
      name: "Remote Quote Update Quoter",
      email: "remotequoteupdatequoter@example.com",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Original remote quoted body</p>",
    });
    const { post: quotePost } = await insertNotePost(tx, {
      account: localQuoter.account,
      content: "Pending quote request",
    });
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: `${quotePost.iri}#quote-request`,
      quotePostId: quotePost.id,
      quotedPostId: remotePost.id,
    });
    const refetched = new Note({
      id: new URL(remotePost.iri),
      attribution: new URL(remoteActor.iri),
      to: PUBLIC_COLLECTION,
      content: "Updated remote quoted body",
    });

    await persistPost(createFedCtx(tx), refetched);

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: localQuoter.account.id,
        type: "quoted_post_updated",
        postId: remotePost.id,
      },
    });
    assert.ok(notification != null);
    assert.deepEqual(notification.actorIds, [remoteActor.id]);
  });
});

test("persistPost() does not notify rejected local quoters when a remote body changes", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "remoterejectedquoteauthor",
      name: "Remote Rejected Quote Author",
      host: "remote.example",
    });
    const localQuoter = await insertAccountWithActor(tx, {
      username: "remoterejectedquotequoter",
      name: "Remote Rejected Quote Quoter",
      email: "remoterejectedquotequoter@example.com",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Original rejected remote quote body</p>",
    });
    const { post: quotePost } = await insertNotePost(tx, {
      account: localQuoter.account,
      content: "Rejected quote request",
    });
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: `${quotePost.iri}#rejected-quote-request`,
      quotePostId: quotePost.id,
      quotedPostId: remotePost.id,
      rejected: new Date("2026-04-15T00:00:00.000Z"),
    });
    const refetched = new Note({
      id: new URL(remotePost.iri),
      attribution: new URL(remoteActor.iri),
      to: PUBLIC_COLLECTION,
      content: "Updated rejected remote quote body",
    });

    await persistPost(createFedCtx(tx), refetched);

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: localQuoter.account.id,
        type: "quoted_post_updated",
        postId: remotePost.id,
      },
    });
    assert.equal(notification, undefined);
  });
});

test("persistPost() does not notify local sharers when the remote body is unchanged", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "remoteunchangedauthor",
      name: "Remote Unchanged Author",
      host: "remote.example",
    });
    const localSharer = await insertAccountWithActor(tx, {
      username: "remoteunchangedsharer",
      name: "Remote Unchanged Sharer",
      email: "remoteunchangedsharer@example.com",
    });
    const remotePost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "Unchanged remote body",
    });
    await insertNotePost(tx, {
      account: localSharer.account,
      content: "",
      sharedPostId: remotePost.id,
    });
    const refetched = new Note({
      id: new URL(remotePost.iri),
      attribution: new URL(remoteActor.iri),
      to: PUBLIC_COLLECTION,
      content: "Unchanged remote body",
    });

    await persistPost(createFedCtx(tx), refetched);

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: localSharer.account.id,
        type: "shared_post_updated",
        postId: remotePost.id,
      },
    });
    assert.equal(notification, undefined);
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

test("persistPost() clears stale quote target state when a remote quote is removed", async () => {
  await withRollback(async (tx) => {
    const quoter = await insertRemoteActor(tx, {
      username: "removedquotequoter",
      name: "Removed Quote Quoter",
      host: "remote.example",
    });
    const existingQuote = await insertRemotePost(tx, {
      actorId: quoter.id,
      contentHtml: "<p>Previously pending quote</p>",
    });
    await tx.update(postTable)
      .set({ quoteTargetState: "pending" })
      .where(eq(postTable.id, existingQuote.id));
    const refetchedQuote = new Note({
      id: new URL(existingQuote.iri),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "No longer a quote",
    });

    const persisted = await persistPost(createFedCtx(tx), refetchedQuote);

    assert.ok(persisted != null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: existingQuote.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, null);
    assert.equal(storedQuote.quoteAuthorizationIri, null);
    assert.equal(storedQuote.quoteTargetState, null);
  });
});

test("persistPost() clears stale quote target state when a remote quote gains authorization", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "stateclearauthauthor",
      name: "State Clear Auth Author",
      email: "stateclearauthauthor@example.com",
    });
    const quoter = await insertRemoteActor(tx, {
      username: "stateclearauthquoter",
      name: "State Clear Auth Quoter",
      host: "remote.example",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Restricted target that later authorizes",
      quotePolicy: "self",
    });
    const existingQuote = await insertRemotePost(tx, {
      actorId: quoter.id,
      contentHtml: "<p>Previously pending authorized quote</p>",
    });
    await tx.update(postTable)
      .set({ quoteTargetState: "pending" })
      .where(eq(postTable.id, existingQuote.id));
    const authorizationIri =
      "http://localhost/objects/state-clear-quote-authorization";
    await tx.insert(quoteAuthorizationTable).values({
      id: generateUuidV7(),
      iri: authorizationIri,
      quotePostIri: existingQuote.iri,
      quotedPostId: quotedPost.id,
      attributedActorId: quotedPost.actorId,
    });
    const refetchedQuote = new Note({
      id: new URL(existingQuote.iri),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Authorized quote",
      quote: new URL(quotedPost.iri),
      quoteAuthorization: new QuoteAuthorization({
        id: new URL(authorizationIri),
        attribution: new URL(author.actor.iri),
        interactingObject: new URL(existingQuote.iri),
        interactionTarget: new URL(quotedPost.iri),
      }),
    });

    const persisted = await persistPost(createFedCtx(tx), refetchedQuote);

    assert.ok(persisted != null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: existingQuote.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, quotedPost.id);
    assert.equal(storedQuote.quoteAuthorizationIri, authorizationIri);
    assert.equal(storedQuote.quoteTargetState, null);
  });
});

test("persistPost() preserves pending quote target state for a still-denied remote quote request", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "statependingauthor",
      name: "State Pending Author",
      email: "statependingauthor@example.com",
    });
    const quoter = await insertRemoteActor(tx, {
      username: "statependingquoter",
      name: "State Pending Quoter",
      host: "remote.example",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Restricted pending target",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const existingQuote = await insertRemotePost(tx, {
      actorId: quoter.id,
      contentHtml: "<p>Pending quote request</p>",
    });
    await tx.update(postTable)
      .set({ quoteTargetState: "pending" })
      .where(eq(postTable.id, existingQuote.id));
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: "https://remote.example/quote-requests/state-pending",
      quotePostId: existingQuote.id,
      quotedPostId: quotedPost.id,
    });
    const refetchedQuote = new Note({
      id: new URL(existingQuote.iri),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Pending quote request",
      quote: new URL(quotedPost.iri),
    });

    const persisted = await persistPost(createFedCtx(tx), refetchedQuote);

    assert.ok(persisted != null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: existingQuote.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, null);
    assert.equal(storedQuote.quoteAuthorizationIri, null);
    assert.equal(storedQuote.quoteTargetState, "pending");
  });
});

test("persistPost() drops quote authorizations without a quote target", async () => {
  await withRollback(async (tx) => {
    const quoter = await insertRemoteActor(tx, {
      username: "danglingquoteauth",
      name: "Dangling Quote Auth",
      host: "remote.example",
    });
    const post = new Note({
      id: new URL("https://remote.example/objects/dangling-quote-auth"),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Authorization without quote",
      quoteAuthorization: new URL(
        "https://remote.example/quote-authorizations/dangling",
      ),
    });

    const persisted = await persistPost(createFedCtx(tx), post);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost, null);
    assert.equal(persisted.quoteAuthorizationIri, null);
    const storedPost = await tx.query.postTable.findFirst({
      where: { id: persisted.id },
    });
    assert.ok(storedPost != null);
    assert.equal(storedPost.quotedPostId, null);
    assert.equal(storedPost.quoteAuthorizationIri, null);
  });
});

test("persistPost() rejects remote self-quotes of direct posts", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "directselfquote",
      name: "Direct Self Quote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Direct remote quote target</p>",
      visibility: "direct",
      quotePolicy: "self",
    });
    const quote = new Note({
      id: new URL("https://remote.example/objects/direct-self-quote"),
      attribution: new URL(remoteActor.iri),
      to: PUBLIC_COLLECTION,
      content: "Remote self quote of direct post",
      quote: new URL(quotedPost.iri),
    });

    const persisted = await persistPost(createFedCtx(tx), quote);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost, null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: persisted.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, null);
    const storedTarget = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.ok(storedTarget != null);
    assert.equal(storedTarget.quotesCount, 0);
  });
});

test("persistPost() rejects forged quote authorizations for local targets", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "forgedquoteauthauthor",
      name: "Forged Quote Auth Author",
      email: "forgedquoteauthauthor@example.com",
    });
    const quoter = await insertRemoteActor(tx, {
      username: "forgedquoteauthquoter",
      name: "Forged Quote Auth Quoter",
      host: "remote.example",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Restricted local quote target",
      quotePolicy: "self",
    });
    const quoteIri =
      "https://remote.example/objects/forged-quote-authorization";
    const forgedAuthorizationIri =
      "https://remote.example/quote-authorizations/forged";
    const quote = new Note({
      id: new URL(quoteIri),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Forged quote authorization",
      quote: new URL(quotedPost.iri),
      quoteAuthorization: new QuoteAuthorization({
        id: new URL(forgedAuthorizationIri),
        attribution: new URL(author.actor.iri),
        interactingObject: new URL(quoteIri),
        interactionTarget: new URL(quotedPost.iri),
      }),
    });

    const persisted = await persistPost(createFedCtx(tx), quote);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost, null);
    assert.equal(persisted.quoteAuthorizationIri, null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: persisted.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, null);
    assert.equal(storedQuote.quoteAuthorizationIri, null);
    const storedTarget = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.ok(storedTarget != null);
    assert.equal(storedTarget.quotesCount, 0);
  });
});

test("persistPost() accepts locally issued quote authorizations", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "issuedquoteauthauthor",
      name: "Issued Quote Auth Author",
      email: "issuedquoteauthauthor@example.com",
    });
    const quoter = await insertRemoteActor(tx, {
      username: "issuedquoteauthquoter",
      name: "Issued Quote Auth Quoter",
      host: "remote.example",
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Restricted local quote target with authorization",
      quotePolicy: "self",
    });
    const quoteIri =
      "https://remote.example/objects/issued-quote-authorization";
    const authorizationIri =
      "http://localhost/objects/issued-quote-authorization";
    await tx.insert(quoteAuthorizationTable).values({
      id: generateUuidV7(),
      iri: authorizationIri,
      quotePostIri: quoteIri,
      quotedPostId: quotedPost.id,
      attributedActorId: quotedPost.actorId,
    });
    const quote = new Note({
      id: new URL(quoteIri),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Locally issued quote authorization",
      quote: new URL(quotedPost.iri),
      quoteAuthorization: new QuoteAuthorization({
        id: new URL(authorizationIri),
        attribution: new URL(author.actor.iri),
        interactingObject: new URL(quoteIri),
        interactionTarget: new URL(quotedPost.iri),
      }),
    });

    const persisted = await persistPost(createFedCtx(tx), quote);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost?.id, quotedPost.id);
    assert.equal(persisted.quoteAuthorizationIri, authorizationIri);
    const storedAuthorization = await tx.query.quoteAuthorizationTable
      .findFirst({
        where: { iri: authorizationIri },
      });
    assert.equal(storedAuthorization?.quotePostId, persisted.id);
  });
});

test("persistPost() rejects remote quote authorizations from the quote origin", async () => {
  await withRollback(async (tx) => {
    const quoter = await insertRemoteActor(tx, {
      username: "forgedremoteauthquoter",
      name: "Forged Remote Auth Quoter",
      host: "remote.example",
    });
    const quotedAuthor = await insertRemoteActor(tx, {
      username: "forgedremoteauthauthor",
      name: "Forged Remote Auth Author",
      host: "quoted.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: quotedAuthor.id,
      contentHtml: "<p>Restricted remote quote target</p>",
      quotePolicy: "self",
    });
    const quoteIri = "https://remote.example/objects/forged-remote-auth";
    const forgedAuthorizationIri =
      "https://remote.example/quote-authorizations/forged-remote";
    const quote = new Note({
      id: new URL(quoteIri),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Forged remote quote authorization",
      quote: new URL(quotedPost.iri),
      quoteAuthorization: new QuoteAuthorization({
        id: new URL(forgedAuthorizationIri),
        attribution: new URL(quotedAuthor.iri),
        interactingObject: new URL(quoteIri),
        interactionTarget: new URL(quotedPost.iri),
      }),
    });

    const persisted = await persistPost(createFedCtx(tx), quote);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost, null);
    assert.equal(persisted.quoteAuthorizationIri, null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: persisted.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, null);
    assert.equal(storedQuote.quoteAuthorizationIri, null);
    const storedTarget = await tx.query.postTable.findFirst({
      where: { id: quotedPost.id },
    });
    assert.ok(storedTarget != null);
    assert.equal(storedTarget.quotesCount, 0);
  });
});

test("persistPost() stores quotes of local shares against the original post", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "sharequoteauthor",
      name: "Share Quote Author",
      email: "sharequoteauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "sharequotesharer",
      name: "Share Quote Sharer",
      email: "sharequotesharer@example.com",
    });
    const { post: originalPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Quotable original",
      quotePolicy: "everyone",
    });
    const { post: sharePost } = await insertNotePost(tx, {
      account: sharer.account,
      content: "Shared original",
      sharedPostId: originalPost.id,
    });
    const quoter = await insertRemoteActor(tx, {
      username: "sharequotequoter",
      name: "Share Quote Quoter",
      host: "remote.example",
    });
    const quote = new Note({
      id: new URL("https://remote.example/objects/share-wrapper-quote"),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Remote quote of share wrapper",
      quote: new URL(sharePost.iri),
    });

    const persisted = await persistPost(createFedCtx(tx), quote);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost?.id, originalPost.id);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: persisted.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, originalPost.id);
    const storedOriginal = await tx.query.postTable.findFirst({
      where: { id: originalPost.id },
    });
    assert.ok(storedOriginal != null);
    assert.equal(storedOriginal.quotesCount, 1);
    const storedShare = await tx.query.postTable.findFirst({
      where: { id: sharePost.id },
    });
    assert.ok(storedShare != null);
    assert.equal(storedShare.quotesCount, 0);
  });
});

test("getAllowedQuoteTargetForActor() unwraps local share chains", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "allowedshareauthor",
      name: "Allowed Share Author",
      email: "allowedshareauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "allowedsharesharer",
      name: "Allowed Share Sharer",
      email: "allowedsharesharer@example.com",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "allowedsharequoter",
      name: "Allowed Share Quoter",
      email: "allowedsharequoter@example.com",
    });
    const { post: originalPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Quotable original",
      quotePolicy: "everyone",
    });
    const { post: firstSharePost } = await insertNotePost(tx, {
      account: sharer.account,
      content: "First share",
      sharedPostId: originalPost.id,
    });
    const { post: secondSharePost } = await insertNotePost(tx, {
      account: sharer.account,
      content: "Second share",
      sharedPostId: firstSharePost.id,
    });

    const target = await getAllowedQuoteTargetForActor(
      tx,
      quoter.actor,
      secondSharePost,
    );

    assert.equal(target?.id, originalPost.id);
  });
});

test("persistPost() does not allow local share quotes to bypass original policy", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "restrictedshareauthor",
      name: "Restricted Share Author",
      email: "restrictedshareauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "restrictedsharesharer",
      name: "Restricted Share Sharer",
      email: "restrictedsharesharer@example.com",
    });
    const { post: originalPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Restricted original",
      quotePolicy: "self",
    });
    const { post: sharePost } = await insertNotePost(tx, {
      account: sharer.account,
      content: "Shared restricted original",
      sharedPostId: originalPost.id,
      quotePolicy: "everyone",
    });
    const quoter = await insertRemoteActor(tx, {
      username: "restrictedsharequoter",
      name: "Restricted Share Quoter",
      host: "remote.example",
    });
    const quote = new Note({
      id: new URL("https://remote.example/objects/restricted-share-quote"),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Remote quote of restricted share wrapper",
      quote: new URL(sharePost.iri),
    });

    const persisted = await persistPost(createFedCtx(tx), quote);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost, null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: persisted.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, null);
    const storedOriginal = await tx.query.postTable.findFirst({
      where: { id: originalPost.id },
    });
    assert.ok(storedOriginal != null);
    assert.equal(storedOriginal.quotesCount, 0);
    const storedShare = await tx.query.postTable.findFirst({
      where: { id: sharePost.id },
    });
    assert.ok(storedShare != null);
    assert.equal(storedShare.quotesCount, 0);
  });
});

test("persistPost() rejects quotes of excessively deep local share chains", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "deepshareauthor",
      name: "Deep Share Author",
      email: "deepshareauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "deepsharesharer",
      name: "Deep Share Sharer",
      email: "deepsharesharer@example.com",
    });
    const { post: originalPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Deeply shared original",
      quotePolicy: "everyone",
    });
    let sharedPostId = originalPost.id;
    for (let i = 0; i < 18; i++) {
      const { post } = await insertNotePost(tx, {
        account: sharer.account,
        content: `Deep share ${i}`,
        sharedPostId,
      });
      sharedPostId = post.id;
    }
    const deepSharePost = await tx.query.postTable.findFirst({
      where: { id: sharedPostId },
    });
    assert.ok(deepSharePost != null);
    const quoter = await insertRemoteActor(tx, {
      username: "deepsharequoter",
      name: "Deep Share Quoter",
      host: "remote.example",
    });
    const quote = new Note({
      id: new URL("https://remote.example/objects/deep-share-quote"),
      attribution: new URL(quoter.iri),
      to: PUBLIC_COLLECTION,
      content: "Remote quote of an excessively deep share chain",
      quote: new URL(deepSharePost.iri),
    });

    const persisted = await persistPost(createFedCtx(tx), quote);

    assert.ok(persisted != null);
    assert.equal(persisted.quotedPost, null);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: persisted.id },
    });
    assert.ok(storedQuote != null);
    assert.equal(storedQuote.quotedPostId, null);
    const storedOriginal = await tx.query.postTable.findFirst({
      where: { id: originalPost.id },
    });
    assert.ok(storedOriginal != null);
    assert.equal(storedOriginal.quotesCount, 0);
  });
});
