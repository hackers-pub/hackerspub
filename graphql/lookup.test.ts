import assert from "node:assert/strict";
import test from "node:test";
import { lookupPostByUrl, parseHttpUrl } from "./lookup.ts";
import {
  insertAccountWithActor,
  insertNotePost,
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
