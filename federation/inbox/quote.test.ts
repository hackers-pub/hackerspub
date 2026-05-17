import type { InboxContext } from "@fedify/fedify";
import {
  Accept,
  Delete,
  Note,
  QuoteAuthorization,
  QuoteRequest,
  Reject,
  Update,
} from "@fedify/vocab";
import assert from "node:assert/strict";
import test from "node:test";
import type { ContextData } from "@hackerspub/models/context";
import {
  followingTable,
  postTable,
  quoteAuthorizationTable,
  quoteRequestTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../../test/postgres.ts";
import {
  onQuoteAuthorizationDeleted,
  onQuoteRequestAccepted,
  onQuoteRequested,
  onQuoteRequestRejected,
} from "./quote.ts";

test("onQuoteRequested rejects instruments not attributed to the requester", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quoteownerauthor",
      name: "Quote Owner Author",
      email: "quoteownerauthor@example.com",
    });
    const requester = await insertRemoteActor(tx, {
      username: "quoterequester",
      name: "Quote Requester",
      host: "remote.example",
    });
    const otherActor = await insertRemoteActor(tx, {
      username: "quoteinstrumentowner",
      name: "Quote Instrument Owner",
      host: "elsewhere.example",
    });
    await tx.insert(followingTable).values({
      iri: `https://remote.example/follows/${requester.id}`,
      followerId: requester.id,
      followeeId: author.actor.id,
      accepted: new Date("2026-04-15T00:00:00.000Z"),
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Followers-only quote target",
      quotePolicy: "followers",
    });
    const instrumentIri = "https://remote.example/objects/not-owned-quote";
    const request = new QuoteRequest({
      id: new URL("https://remote.example/quote-requests/not-owned"),
      actor: new URL(requester.iri),
      object: new URL(quotedPost.iri),
      instrument: new URL(instrumentIri),
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      lookupObject(identifier: string | URL) {
        assert.equal(new URL(identifier).href, instrumentIri);
        return Promise.resolve(
          new Note({
            id: new URL(instrumentIri),
            attribution: new URL(otherActor.iri),
            content: "Not owned by requester",
          }),
        );
      },
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as InboxContext<ContextData>;

    await onQuoteRequested(fedCtx, request);

    const authorization = await tx.query.quoteAuthorizationTable.findFirst({
      where: { quotePostIri: instrumentIri },
    });
    assert.equal(authorization, undefined);
    assert.equal(sent.some((args) => args[2] instanceof Reject), true);
  });
});

test("onQuoteRequestAccepted federates updated quote authorization", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoteacceptremote",
      name: "Quote Accept Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Approved remote post</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoteacceptlocal",
      name: "Quote Accept Local",
      email: "quoteacceptlocal@example.com",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Quoting after manual approval",
      quotedPostId: quotedPost.id,
    });
    assert.ok(quote.noteSourceId != null);
    const originalNoteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: quote.noteSourceId },
    });
    assert.ok(originalNoteSource != null);
    const authorizationIri = "https://remote.example/quote-authorization/1";
    const request = new QuoteRequest({
      id: new URL("https://localhost/quote-requests/1"),
      actor: new URL(quoter.actor.iri),
      object: new URL(quotedPost.iri),
      instrument: new URL(quote.iri),
    });
    const authorization = new QuoteAuthorization({
      id: new URL(authorizationIri),
      attribution: new URL(remoteActor.iri),
      interactingObject: new URL(quote.iri),
      interactionTarget: new URL(quotedPost.iri),
    });
    const accept = new Accept({
      id: new URL("https://remote.example/quote-requests/1#accept"),
      actor: new URL(remoteActor.iri),
      object: request,
      result: authorization,
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as InboxContext<ContextData>;

    assert.equal(await onQuoteRequestAccepted(fedCtx, accept), true);

    const updatedQuote = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(updatedQuote?.quoteAuthorizationIri, authorizationIri);
    const updatedNoteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: quote.noteSourceId },
    });
    assert.ok(updatedNoteSource != null);
    assert.ok(updatedNoteSource.updated > originalNoteSource.updated);

    const update = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Update);
    assert.ok(update instanceof Update);
    const updatedObject = await update.getObject({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(updatedObject instanceof Note);
    assert.equal(updatedObject.quoteAuthorizationId?.href, authorizationIri);
    assert.ok(updatedObject.updated != null);
  });
});

test("onQuoteRequestAccepted resolves referenced quote request IDs", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoterefremote",
      name: "Quote Reference Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Referenced request approval</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quotereflocal",
      name: "Quote Reference Local",
      email: "quotereflocal@example.com",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Quoting with referenced request",
      quotedPostId: quotedPost.id,
    });
    const requestIri = new URL("#quote-request", quote.iri).href;
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestIri,
      quotePostId: quote.id,
      quotedPostId: quotedPost.id,
    });
    const authorizationIri =
      "https://remote.example/quote-authorization/reference";
    const authorization = new QuoteAuthorization({
      id: new URL(authorizationIri),
      attribution: new URL(remoteActor.iri),
      interactingObject: new URL(quote.iri),
      interactionTarget: new URL(quotedPost.iri),
    });
    const accept = new Accept({
      id: new URL("https://remote.example/quote-requests/reference#accept"),
      actor: new URL(remoteActor.iri),
      object: new URL(requestIri),
      result: authorization,
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as InboxContext<ContextData>;

    assert.equal(await onQuoteRequestAccepted(fedCtx, accept), true);

    const updatedQuote = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(updatedQuote?.quoteAuthorizationIri, authorizationIri);
    const storedRequest = await tx.query.quoteRequestTable.findFirst({
      where: { iri: requestIri },
    });
    assert.ok(storedRequest?.accepted != null);
    assert.equal(storedRequest.rejected, null);
    assert.equal(sent.some((args) => args[2] instanceof Update), true);
  });
});

test("onQuoteRequestRejected federates quote removal", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoterejectremote",
      name: "Quote Reject Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Rejected remote post</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoterejectlocal",
      name: "Quote Reject Local",
      email: "quoterejectlocal@example.com",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Quoting before rejection",
      quotedPostId: quotedPost.id,
    });
    assert.ok(quote.noteSourceId != null);
    const originalNoteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: quote.noteSourceId },
    });
    assert.ok(originalNoteSource != null);
    const requestIri = new URL("#quote-request", quote.iri).href;
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestIri,
      quotePostId: quote.id,
      quotedPostId: quotedPost.id,
    });
    const reject = new Reject({
      id: new URL("https://remote.example/quote-requests/reject#reject"),
      actor: new URL(remoteActor.iri),
      object: new URL(requestIri),
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as InboxContext<ContextData>;

    assert.equal(await onQuoteRequestRejected(fedCtx, reject), true);

    const updatedQuote = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(updatedQuote?.quotedPostId, null);
    assert.equal(updatedQuote?.quoteAuthorizationIri, null);
    const updatedNoteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: quote.noteSourceId },
    });
    assert.ok(updatedNoteSource != null);
    assert.ok(updatedNoteSource.updated > originalNoteSource.updated);

    const update = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Update);
    assert.ok(update instanceof Update);
    const updatedObject = await update.getObject({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(updatedObject instanceof Note);
    assert.equal(updatedObject.quoteId, null);
    assert.equal(updatedObject.quoteUrl, null);
    assert.equal(updatedObject.quoteAuthorizationId, null);
    assert.ok(updatedObject.updated != null);
  });
});

test("onQuoteAuthorizationDeleted federates quote removal", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quotedeleteremote",
      name: "Quote Delete Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Deleted authorization target</p>",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quotedeletelocal",
      name: "Quote Delete Local",
      email: "quotedeletelocal@example.com",
    });
    const authorizationIri =
      "https://remote.example/quote-authorization/delete";
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Quoting before authorization deletion",
      quotedPostId: quotedPost.id,
    });
    assert.ok(quote.noteSourceId != null);
    await tx.update(postTable)
      .set({ quoteAuthorizationIri: authorizationIri })
      .where(eq(postTable.id, quote.id));
    await tx.insert(quoteAuthorizationTable).values({
      id: generateUuidV7(),
      iri: authorizationIri,
      quotePostIri: quote.iri,
      quotePostId: quote.id,
      quotedPostId: quotedPost.id,
      attributedActorId: remoteActor.id,
    });
    const originalNoteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: quote.noteSourceId },
    });
    assert.ok(originalNoteSource != null);
    const del = new Delete({
      id: new URL("https://remote.example/quote-authorization/delete#delete"),
      actor: new URL(remoteActor.iri),
      object: new URL(authorizationIri),
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as InboxContext<ContextData>;

    assert.equal(await onQuoteAuthorizationDeleted(fedCtx, del), true);

    const updatedQuote = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(updatedQuote?.quotedPostId, null);
    assert.equal(updatedQuote?.quoteAuthorizationIri, null);
    const authorization = await tx.query.quoteAuthorizationTable.findFirst({
      where: { iri: authorizationIri },
    });
    assert.equal(authorization?.revoked, true);
    const updatedNoteSource = await tx.query.noteSourceTable.findFirst({
      where: { id: quote.noteSourceId },
    });
    assert.ok(updatedNoteSource != null);
    assert.ok(updatedNoteSource.updated > originalNoteSource.updated);

    const update = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Update);
    assert.ok(update instanceof Update);
    const updatedObject = await update.getObject({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(updatedObject instanceof Note);
    assert.equal(updatedObject.quoteId, null);
    assert.equal(updatedObject.quoteUrl, null);
    assert.equal(updatedObject.quoteAuthorizationId, null);
    assert.ok(updatedObject.updated != null);
  });
});
