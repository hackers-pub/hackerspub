import assert from "node:assert";
import test from "node:test";
import { lookupActorByUrl, lookupPostByUrl, parseHttpUrl } from "./lookup.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  makeGuestContext,
  withRollback,
} from "../test/postgres.ts";

test("parseHttpUrl() accepts only http and https URLs", () => {
  assert.equal(
    parseHttpUrl("https://example.com/post")?.href,
    "https://example.com/post",
  );
  assert.equal(
    parseHttpUrl("http://example.com/post")?.href,
    "http://example.com/post",
  );
  assert.equal(parseHttpUrl("ftp://example.com/post"), null);
  assert.equal(parseHttpUrl("not a url"), null);
});

test("lookupPostByUrl() returns a local non-share post by URL", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "lookuppostauthor",
      name: "Lookup Post Author",
      email: "lookuppostauthor@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Lookup me",
    });

    const found = await lookupPostByUrl(
      makeGuestContext(tx),
      new URL(post.url!),
    );

    assert.ok(found != null);
    assert.equal(found.id, post.id);
  });
});

test("lookupPostByUrl() ignores local share rows when matching URLs", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "lookupshareauthor",
      name: "Lookup Share Author",
      email: "lookupshareauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "lookupsharer",
      name: "Lookup Sharer",
      email: "lookupsharer@example.com",
    });
    const { post: original } = await insertNotePost(tx, {
      account: author.account,
      content: "Original post",
    });
    const { post: share } = await insertNotePost(tx, {
      account: sharer.account,
      actorId: sharer.actor.id,
      content: "Shared post",
      sharedPostId: original.id,
    });

    const ignoredShare = await lookupPostByUrl(
      makeGuestContext(tx),
      new URL(share.iri),
    );

    assert.equal(ignoredShare, null);
  });
});

test("lookupPostByUrl() refuses federation lookup for guests", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const fedCtx = createFedCtx(tx, {
      lookupObject: (uri) => {
        lookupCalls.push(uri.toString());
        return Promise.resolve(null);
      },
    });
    const ctx = makeGuestContext(tx, { fedCtx });

    const result = await lookupPostByUrl(
      ctx,
      new URL("https://unknown.example/posts/missing"),
    );

    assert.equal(result, null);
    assert.deepEqual(lookupCalls, []);
  });
});

test("lookupActorByUrl() returns a local actor by IRI", async () => {
  await withRollback(async (tx) => {
    const remote = await insertRemoteActor(tx, {
      username: "lookupactoriri",
      name: "Lookup Actor IRI",
      host: "remote.example",
    });

    const found = await lookupActorByUrl(
      makeGuestContext(tx),
      new URL(remote.iri),
    );

    assert.ok(found != null);
    assert.equal(found.id, remote.id);
  });
});

test("lookupActorByUrl() refuses federation lookup for guests", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const fedCtx = createFedCtx(tx, {
      lookupObject: (uri) => {
        lookupCalls.push(uri.toString());
        return Promise.resolve(null);
      },
    });
    const ctx = makeGuestContext(tx, { fedCtx });

    const result = await lookupActorByUrl(
      ctx,
      new URL("https://unknown.example/users/missing"),
    );

    assert.equal(result, null);
    assert.deepEqual(lookupCalls, []);
  });
});
