import assert from "node:assert";
import { describe, it } from "node:test";
import type { InboxContext } from "@fedify/fedify";
import {
  Accept,
  type Delete,
  type Follow,
  Note,
  QuoteAuthorization,
  type Reject,
} from "@fedify/vocab";
import { eq } from "drizzle-orm";
import type { ContextData } from "@hackerspub/models/context";
import { postTable, quoteRequestTable } from "@hackerspub/models/schema";
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
  onAccepted,
  onDeleted,
  onFollowReceived,
  onRejected,
} from "./dispatch.ts";

describe("transactional inbox dispatch", () => {
  it("accepts Mastodon quote approvals with an unresolvable request fragment", async () => {
    await withRollback(async (tx) => {
      const remoteActor = await insertRemoteActor(tx, {
        username: "mastodonquoteowner",
        name: "Mastodon Quote Owner",
        host: "mastodon.example",
      });
      const quotedPost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Quoted from Mastodon</p>",
      });
      const quoter = await insertAccountWithActor(tx, {
        username: "mastodonquoter",
        name: "Mastodon Quoter",
        email: "mastodonquoter@example.com",
      });
      const { post: quote } = await insertNotePost(tx, {
        account: quoter.account,
        content: "A pending Mastodon quote",
        quotedPostId: quotedPost.id,
      });
      await tx
        .update(postTable)
        .set({ quotedPostId: null, quoteTargetState: "pending" })
        .where(eq(postTable.id, quote.id));
      const currentRequestIri = new URL("#quote-request/current", quote.iri)
        .href;
      await tx.insert(quoteRequestTable).values({
        id: generateUuidV7(),
        iri: currentRequestIri,
        quotePostId: quote.id,
        quotedPostId: quotedPost.id,
      });

      const staleRequestIri = new URL("#quote-request/mastodon-copy", quote.iri)
        .href;
      const authorizationIri =
        "https://mastodon.example/users/owner/quote_authorizations/1";
      const authorization = new QuoteAuthorization({
        id: new URL(authorizationIri),
        attribution: new URL(remoteActor.iri),
        interactingObject: new URL(quote.iri),
        interactionTarget: new URL(quotedPost.iri),
      });
      const accept = await Accept.fromJsonLd({
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" },
        ],
        id: "https://mastodon.example/users/owner#accepts/quotes/1",
        type: "Accept",
        actor: remoteActor.iri,
        object: {
          id: staleRequestIri,
          type: "QuoteRequest",
          actor: quoter.actor.iri,
          object: quotedPost.iri,
          instrument: quote.iri,
        },
        result: authorizationIri,
      });
      const loaded = new Set<string>();
      const fedCtx = {
        ...createFedCtx(tx),
        async documentLoader(url: string) {
          loaded.add(url);
          if (url === authorizationIri) {
            return {
              contextUrl: null,
              documentUrl: url,
              document: await authorization.toJsonLd(),
            };
          }
          assert.equal(url, staleRequestIri);
          return {
            contextUrl: null,
            documentUrl: url,
            document: await new Note({
              id: new URL(quote.iri),
              attribution: new URL(quoter.actor.iri),
            }).toJsonLd(),
          };
        },
      } as unknown as InboxContext<ContextData>;

      await onAccepted(fedCtx, accept);

      assert.deepEqual(loaded, new Set([authorizationIri]));
      const updatedQuote = await tx.query.postTable.findFirst({
        where: { id: quote.id },
      });
      assert.equal(updatedQuote?.quoteAuthorizationIri, authorizationIri);
      assert.equal(updatedQuote?.quoteTargetState, null);
      const currentRequest = await tx.query.quoteRequestTable.findFirst({
        where: { iri: currentRequestIri },
      });
      assert.ok(currentRequest?.accepted != null);
    });
  });

  it("uses a stored quote request when dereferencing it fails", async () => {
    await withRollback(async (tx) => {
      const remoteActor = await insertRemoteActor(tx, {
        username: "unavailablequoteowner",
        name: "Unavailable Quote Owner",
        host: "remote.example",
      });
      const quotedPost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Quoted while the request IRI is unavailable</p>",
      });
      const quoter = await insertAccountWithActor(tx, {
        username: "unavailablequoter",
        name: "Unavailable Quoter",
        email: "unavailablequoter@example.com",
      });
      const { post: quote } = await insertNotePost(tx, {
        account: quoter.account,
        content: "A pending quote with a stored request",
        quotedPostId: quotedPost.id,
      });
      await tx
        .update(postTable)
        .set({ quotedPostId: null, quoteTargetState: "pending" })
        .where(eq(postTable.id, quote.id));
      const requestIri = new URL("#quote-request/stored", quote.iri).href;
      await tx.insert(quoteRequestTable).values({
        id: generateUuidV7(),
        iri: requestIri,
        quotePostId: quote.id,
        quotedPostId: quotedPost.id,
      });
      const authorizationIri =
        "https://remote.example/quote-authorizations/stored";
      const authorization = new QuoteAuthorization({
        id: new URL(authorizationIri),
        attribution: new URL(remoteActor.iri),
        interactingObject: new URL(quote.iri),
        interactionTarget: new URL(quotedPost.iri),
      });
      const accept = new Accept({
        actor: new URL(remoteActor.iri),
        object: new URL(requestIri),
        result: new URL(authorizationIri),
      });
      const loaded = new Set<string>();
      const fedCtx = {
        ...createFedCtx(tx),
        async documentLoader(url: string) {
          loaded.add(url);
          if (url === requestIri) throw new Error("request unavailable");
          assert.equal(url, authorizationIri);
          return {
            contextUrl: null,
            documentUrl: url,
            document: await authorization.toJsonLd(),
          };
        },
      } as unknown as InboxContext<ContextData>;

      await onAccepted(fedCtx, accept);

      assert.deepEqual(loaded, new Set([requestIri, authorizationIri]));
      const updatedQuote = await tx.query.postTable.findFirst({
        where: { id: quote.id },
      });
      assert.equal(updatedQuote?.quoteAuthorizationIri, authorizationIri);
      const storedRequest = await tx.query.quoteRequestTable.findFirst({
        where: { iri: requestIri },
      });
      assert.ok(storedRequest?.accepted != null);
    });
  });

  it("retries failed Follow dereferences for result-bearing Accepts", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx) as unknown as InboxContext<ContextData>;
      const follow = {
        id: new URL("https://remote.example/follows/with-result"),
        actorId: new URL("https://remote.example/users/follower"),
        objectId: new URL("https://localhost/actors/unknown"),
      } as unknown as Follow;
      const dereferences: {
        crossOrigin?: "ignore" | "throw" | "trust";
        suppressError?: boolean;
      }[] = [];
      const accept = {
        actorId: new URL("https://remote.example/users/followee"),
        objectId: follow.id,
        resultId: new URL("https://remote.example/follows/result"),
        getObject(options: {
          crossOrigin?: "ignore" | "throw" | "trust";
          suppressError?: boolean;
        }) {
          dereferences.push(options);
          return Promise.resolve(dereferences.length === 1 ? null : follow);
        },
        getResult() {
          return Promise.resolve(null);
        },
      } as unknown as Accept;

      await onAccepted(fedCtx, accept);

      assert.equal(dereferences.length, 2);
      assert.deepEqual(
        dereferences.map(({ crossOrigin, suppressError }) => ({
          crossOrigin,
          suppressError,
        })),
        [
          { crossOrigin: "trust", suppressError: true },
          { crossOrigin: "trust", suppressError: undefined },
        ],
      );
    });
  });

  it("dereferences Accept and Reject activities before opening a transaction", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx) as unknown as InboxContext<ContextData>;
      const dereferencedWith = new Set<ContextData["db"]>();
      const accept = {
        actorId: null,
        objectId: null,
        resultId: new URL("https://remote.example/authorizations/1"),
        getObject(options: InboxContext<ContextData>) {
          dereferencedWith.add(options.data.db);
          return Promise.resolve(null);
        },
        getResult(options: InboxContext<ContextData>) {
          dereferencedWith.add(options.data.db);
          return Promise.resolve(null);
        },
      } as unknown as Accept;
      const reject = {
        actorId: null,
        objectId: null,
        getObject(options: InboxContext<ContextData>) {
          dereferencedWith.add(options.data.db);
          return Promise.resolve(null);
        },
      } as unknown as Reject;

      await onAccepted(fedCtx, accept);
      await onRejected(fedCtx, reject);

      assert.deepEqual([...dereferencedWith], [tx]);
    });
  });

  it("dereferences deleted posts between the database-only dispatch phases", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx) as unknown as InboxContext<ContextData>;
      let dereferenceDb: ContextData["db"] | undefined;
      const del = {
        actorId: new URL("https://remote.example/actors/alice"),
        objectId: new URL("https://remote.example/posts/1"),
        getObject(options: InboxContext<ContextData>) {
          dereferenceDb = options.data.db;
          return Promise.resolve(null);
        },
      } as unknown as Delete;

      await onDeleted(fedCtx, del);

      assert.equal(dereferenceDb, tx);
    });
  });

  it("does not dereference a Delete without IDs", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx) as unknown as InboxContext<ContextData>;
      let dereferenced = false;
      const del = {
        actorId: null,
        objectId: null,
        getObject() {
          dereferenced = true;
          return Promise.resolve(null);
        },
      } as unknown as Delete;

      await onDeleted(fedCtx, del);

      assert.equal(dereferenced, false);
    });
  });

  it("does not dereference a cross-origin Delete object", async () => {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx) as unknown as InboxContext<ContextData>;
      let dereferenced = false;
      const del = {
        actorId: new URL("https://remote.example/actors/alice"),
        objectId: new URL("https://objects.example/posts/1"),
        getObject() {
          dereferenced = true;
          return Promise.resolve(null);
        },
      } as unknown as Delete;

      await onDeleted(fedCtx, del);

      assert.equal(dereferenced, false);
    });
  });

  it("resolves a Follow actor before opening the relationship transaction", async () => {
    await withRollback(async (tx) => {
      const local = await insertAccountWithActor(tx, {
        username: "followed",
        name: "Followed",
        email: "followed@example.com",
      });
      const fedCtx = createFedCtx(tx) as unknown as InboxContext<ContextData>;
      Object.assign(fedCtx, {
        parseUri(uri: URL | null) {
          return uri?.href === local.actor.iri
            ? { type: "actor", identifier: local.account.id }
            : null;
        },
      });
      let dereferenceDb: ContextData["db"] | undefined;
      const follow = {
        id: new URL("https://remote.example/follows/1"),
        actorId: new URL("https://remote.example/actors/alice"),
        objectId: new URL(local.actor.iri),
        getActor(context: InboxContext<ContextData>) {
          dereferenceDb = context.data.db;
          return Promise.resolve(null);
        },
      } as unknown as Follow;

      await onFollowReceived(fedCtx, follow);

      assert.equal(dereferenceDb, tx);
    });
  });

  it("does not dereference a Follow without an actor ID", async () => {
    await withRollback(async (tx) => {
      const local = await insertAccountWithActor(tx, {
        username: "followedwithoutactor",
        name: "Followed Without Actor",
        email: "followedwithoutactor@example.com",
      });
      const fedCtx = createFedCtx(tx) as unknown as InboxContext<ContextData>;
      Object.assign(fedCtx, {
        parseUri(uri: URL | null) {
          return uri?.href === local.actor.iri
            ? { type: "actor", identifier: local.account.id }
            : null;
        },
      });
      let dereferenced = false;
      const follow = {
        id: new URL("https://remote.example/follows/without-actor"),
        actorId: null,
        objectId: new URL(local.actor.iri),
        getActor() {
          dereferenced = true;
          return Promise.resolve(null);
        },
      } as unknown as Follow;

      await onFollowReceived(fedCtx, follow);

      assert.equal(dereferenced, false);
    });
  });
});
