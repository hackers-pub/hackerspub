import type { InboxContext } from "@fedify/fedify";
import {
  Accept,
  Note,
  QuoteAuthorization,
  QuoteRequest,
  Update,
} from "@fedify/vocab";
import assert from "node:assert/strict";
import test from "node:test";
import type { ContextData } from "@hackerspub/models/context";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../../test/postgres.ts";
import { onQuoteRequestAccepted } from "./quote.ts";

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
  });
});
