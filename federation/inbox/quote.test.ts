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
import process from "node:process";
import test from "node:test";
import { eq } from "drizzle-orm";
import type { ContextData } from "@hackerspub/models/context";
import {
  followingTable,
  postTable,
  quoteAuthorizationTable,
  quoteRequestTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
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
            quote: new URL(quotedPost.iri),
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

test("onQuoteRequested rejects cross-origin instruments before fetching", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quoteoriginowner",
      name: "Quote Origin Owner",
      email: "quoteoriginowner@example.com",
    });
    const requester = await insertRemoteActor(tx, {
      username: "quoteoriginrequester",
      name: "Quote Origin Requester",
      host: "remote.example",
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
    const instrumentIri = "https://metadata.example/objects/cross-origin";
    const request = new QuoteRequest({
      id: new URL("https://remote.example/quote-requests/cross-origin"),
      actor: new URL(requester.iri),
      object: new URL(quotedPost.iri),
      instrument: new URL(instrumentIri),
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      lookupObject() {
        throw new Error("cross-origin instrument should not be fetched");
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

test("onQuoteRequested leaves request-only follower approvals pending", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quoterequestauthor",
      name: "Quote Request Author",
      email: "quoterequestauthor@example.com",
    });
    const requester = await insertRemoteActor(tx, {
      username: "quoterequestfollower",
      name: "Quote Request Follower",
      host: "remote.example",
    });
    await tx.insert(followingTable).values({
      iri: `https://remote.example/follows/${requester.id}`,
      followerId: requester.id,
      followeeId: author.actor.id,
      accepted: new Date("2026-04-15T00:00:00.000Z"),
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Manual follower quote target",
      quotePolicy: "self",
      quoteRequestPolicy: "followers",
    });
    const instrumentIri =
      "https://remote.example/objects/request-only-follower-quote";
    const request = new QuoteRequest({
      id: new URL("https://remote.example/quote-requests/request-only"),
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
            attribution: new URL(requester.iri),
            quote: new URL(quotedPost.iri),
            content: "Owned by requester",
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
    assert.equal(sent.some((args) => args[2] instanceof Accept), false);
    assert.equal(sent.some((args) => args[2] instanceof Reject), false);
    const storedQuote = await tx.query.postTable.findFirst({
      where: { iri: instrumentIri },
    });
    assert.ok(storedQuote != null);
    const storedRequest = await tx.query.quoteRequestTable.findFirst({
      where: { iri: request.id!.href },
    });
    assert.equal(storedRequest?.quotePostId, storedQuote.id);
    assert.equal(storedRequest?.quotedPostId, quotedPost.id);
    assert.equal(storedRequest?.accepted, null);
    assert.equal(storedRequest?.rejected, null);
  });
});

test("onQuoteRequested rejects instruments that do not quote the object", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quotetargetauthor",
      name: "Quote Target Author",
      email: "quotetargetauthor@example.com",
    });
    const requester = await insertRemoteActor(tx, {
      username: "quotetargetrequester",
      name: "Quote Target Requester",
      host: "remote.example",
    });
    await tx.insert(followingTable).values({
      iri: `https://remote.example/follows/${requester.id}`,
      followerId: requester.id,
      followeeId: author.actor.id,
      accepted: new Date("2026-04-15T00:00:00.000Z"),
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Manual target",
      quotePolicy: "self",
      quoteRequestPolicy: "followers",
    });
    const instrumentIri = "https://remote.example/objects/wrong-target-quote";
    const request = new QuoteRequest({
      id: new URL("https://remote.example/quote-requests/wrong-target"),
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
            attribution: new URL(requester.iri),
            quote: new URL("https://remote.example/objects/another-target"),
            content: "Owned by requester, but quoting another object",
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

test("onQuoteRequested unwraps local share targets", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "quoteshareauthor",
      name: "Quote Share Author",
      email: "quoteshareauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "quotesharesharer",
      name: "Quote Share Sharer",
      email: "quotesharesharer@example.com",
    });
    const requester = await insertRemoteActor(tx, {
      username: "quotesharerequester",
      name: "Quote Share Requester",
      host: "remote.example",
    });
    await tx.insert(followingTable).values({
      iri: `https://remote.example/follows/${requester.id}`,
      followerId: requester.id,
      followeeId: author.actor.id,
      accepted: new Date("2026-04-15T00:00:00.000Z"),
    });
    const { post: quotedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Automatic approval original",
      quotePolicy: "followers",
    });
    const { post: sharePost } = await insertNotePost(tx, {
      account: sharer.account,
      content: "Share wrapper",
      sharedPostId: quotedPost.id,
    });
    const instrumentIri = "https://remote.example/objects/share-wrapper-quote";
    const request = new QuoteRequest({
      id: new URL("https://remote.example/quote-requests/share-wrapper"),
      actor: new URL(requester.iri),
      object: new URL(sharePost.iri),
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
            attribution: new URL(requester.iri),
            quote: new URL(sharePost.iri),
            content: "Owned by requester",
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
    assert.ok(authorization != null);
    assert.equal(authorization.quotedPostId, quotedPost.id);
    assert.equal(sent.some((args) => args[2] instanceof Accept), true);
    assert.equal(sent.some((args) => args[2] instanceof Reject), false);
  });
});

test("onQuoteRequestAccepted federates updated quote authorization", async () => {
  await withTagsPubRelayEnabled(async () => {
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
        content: "Quoting after manual approval #Fediverse",
        quotedPostId: quotedPost.id,
      });
      assert.ok(quote.noteSourceId != null);
      await tx.update(postTable)
        .set({ relayedTags: ["fediverse"] })
        .where(eq(postTable.id, quote.id));
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
      assert.equal(
        sent.some((args) =>
          args[2] instanceof Update &&
          args[1] != null &&
          typeof args[1] === "object" &&
          "id" in args[1] &&
          args[1].id instanceof URL &&
          args[1].id.href === "https://tags.pub/user/_____relay_____"
        ),
        true,
      );
    });
  });
});

test("onQuoteRequestAccepted ignores mismatched quote authorization IDs", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quotemismatchremote",
      name: "Quote Mismatch Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Mismatched authorization target</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quotemismatchlocal",
      name: "Quote Mismatch Local",
      email: "quotemismatchlocal@example.com",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Quoting with mismatched authorization",
      quotedPostId: quotedPost.id,
    });
    const authorizationIri =
      "https://remote.example/quote-authorization/mismatch";
    const authorization = new QuoteAuthorization({
      id: new URL("https://remote.example/quote-authorization/other"),
      attribution: new URL(remoteActor.iri),
      interactingObject: new URL(quote.iri),
      interactionTarget: new URL(quotedPost.iri),
    });
    const request = new QuoteRequest({
      id: new URL("https://localhost/quote-requests/mismatch"),
      actor: new URL(quoter.actor.iri),
      object: new URL(quotedPost.iri),
      instrument: new URL(quote.iri),
    });
    const accept = new Accept({
      id: new URL("https://remote.example/quote-requests/mismatch#accept"),
      actor: new URL(remoteActor.iri),
      object: request,
      result: new URL(authorizationIri),
    });
    (accept as unknown as {
      getResult: () => Promise<QuoteAuthorization>;
    }).getResult = () => Promise.resolve(authorization);
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
    assert.equal(updatedQuote?.quoteAuthorizationIri, null);
    assert.equal(sent.some((args) => args[2] instanceof Update), false);
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

test("onQuoteRequestAccepted reattaches pending quote targets", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoteattachremote",
      name: "Quote Attach Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Pending quote target</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoteattachlocal",
      name: "Quote Attach Local",
      email: "quoteattachlocal@example.com",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Pending quote awaiting approval",
      quotedPostId: quotedPost.id,
    });
    await tx.update(postTable)
      .set({ quotedPostId: null, quoteAuthorizationIri: null })
      .where(eq(postTable.id, quote.id));
    const requestIri = new URL("#quote-request", quote.iri).href;
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestIri,
      quotePostId: quote.id,
      quotedPostId: quotedPost.id,
    });
    const authorizationIri =
      "https://remote.example/quote-authorization/reattach";
    const authorization = new QuoteAuthorization({
      id: new URL(authorizationIri),
      attribution: new URL(remoteActor.iri),
      interactingObject: new URL(quote.iri),
      interactionTarget: new URL(quotedPost.iri),
    });
    const accept = new Accept({
      id: new URL("https://remote.example/quote-requests/reattach#accept"),
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
    assert.equal(updatedQuote?.quotedPostId, quotedPost.id);
    assert.equal(updatedQuote?.quoteAuthorizationIri, authorizationIri);
    const storedRequest = await tx.query.quoteRequestTable.findFirst({
      where: { iri: requestIri },
    });
    assert.ok(storedRequest?.accepted != null);
    assert.equal(storedRequest.rejected, null);
    const update = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Update);
    assert.ok(update instanceof Update);
    const updatedObject = await update.getObject({
      ...fedCtx,
      suppressError: true,
    });
    assert.ok(updatedObject instanceof Note);
    assert.equal(updatedObject.quoteId?.href, quotedPost.iri);
    assert.equal(updatedObject.quoteAuthorizationId?.href, authorizationIri);
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

test("onQuoteRequestRejected records detached pending requests", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoterejectpendingremote",
      name: "Quote Reject Pending Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Pending rejected target</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoterejectpending",
      name: "Quote Reject Pending",
      email: "quoterejectpending@example.com",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Pending quote rejected before attachment",
      quotedPostId: quotedPost.id,
    });
    await tx.update(postTable)
      .set({ quotedPostId: null, quoteAuthorizationIri: null })
      .where(eq(postTable.id, quote.id));
    const requestIri = new URL("#quote-request", quote.iri).href;
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestIri,
      quotePostId: quote.id,
      quotedPostId: quotedPost.id,
    });
    const reject = new Reject({
      id: new URL("https://remote.example/quote-requests/pending#reject"),
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

    const storedRequest = await tx.query.quoteRequestTable.findFirst({
      where: { iri: requestIri },
    });
    assert.equal(storedRequest?.accepted, null);
    assert.ok(storedRequest?.rejected != null);
    const updatedQuote = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(updatedQuote?.quotedPostId, null);
    assert.equal(sent.some((args) => args[2] instanceof Update), false);
  });
});

test("onQuoteRequestRejected ignores stale targets", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoterejectstaleremote",
      name: "Quote Reject Stale Remote",
      host: "remote.example",
    });
    const staleTarget = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Old quote target</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const currentTarget = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Current quote target</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoterejectstale",
      name: "Quote Reject Stale",
      email: "quoterejectstale@example.com",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Retargeted quote",
      quotedPostId: currentTarget.id,
    });
    const requestIri = new URL("#quote-request", quote.iri).href;
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestIri,
      quotePostId: quote.id,
      quotedPostId: staleTarget.id,
    });
    const reject = new Reject({
      id: new URL("https://remote.example/quote-requests/stale#reject"),
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

    const storedQuote = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(storedQuote?.quotedPostId, currentTarget.id);
    assert.equal(sent.length, 0);
  });
});

test("onQuoteRequestRejected does not fan out none visibility quotes", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoterejectnoneremote",
      name: "Quote Reject None Remote",
      host: "remote.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Rejected none visibility target</p>",
      quotePolicy: "self",
      quoteRequestPolicy: "everyone",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoterejectnone",
      name: "Quote Reject None",
      email: "quoterejectnone@example.com",
    });
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Private quote before rejection",
      quotedPostId: quotedPost.id,
      visibility: "none",
    });
    const requestIri = new URL("#quote-request", quote.iri).href;
    await tx.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestIri,
      quotePostId: quote.id,
      quotedPostId: quotedPost.id,
    });
    const reject = new Reject({
      id: new URL("https://remote.example/quote-requests/none#reject"),
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

    assert.equal(sent.some((args) => args[1] === "followers"), false);
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

test("onQuoteAuthorizationDeleted falls through on actor mismatch", async () => {
  await withRollback(async (tx) => {
    const remoteActor = await insertRemoteActor(tx, {
      username: "quoteauthowner",
      name: "Quote Auth Owner",
      host: "remote.example",
    });
    const otherActor = await insertRemoteActor(tx, {
      username: "quoteauthimpostor",
      name: "Quote Auth Impostor",
      host: "elsewhere.example",
    });
    const quotedPost = await insertRemotePost(tx, {
      actorId: remoteActor.id,
      contentHtml: "<p>Authorization target</p>",
    });
    const quoter = await insertAccountWithActor(tx, {
      username: "quoteauthlocal",
      name: "Quote Auth Local",
      email: "quoteauthlocal@example.com",
    });
    const authorizationIri =
      "https://remote.example/quote-authorization/mismatch";
    const { post: quote } = await insertNotePost(tx, {
      account: quoter.account,
      content: "Quoting before mismatched authorization deletion",
      quotedPostId: quotedPost.id,
    });
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
    const del = new Delete({
      id: new URL("https://elsewhere.example/delete/mismatch"),
      actor: new URL(otherActor.iri),
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

    assert.equal(await onQuoteAuthorizationDeleted(fedCtx, del), false);

    const updatedQuote = await tx.query.postTable.findFirst({
      where: { id: quote.id },
    });
    assert.equal(updatedQuote?.quotedPostId, quotedPost.id);
    assert.equal(updatedQuote?.quoteAuthorizationIri, authorizationIri);
    const authorization = await tx.query.quoteAuthorizationTable.findFirst({
      where: { iri: authorizationIri },
    });
    assert.equal(authorization?.revoked, false);
    assert.equal(sent.length, 0);
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
