import assert from "node:assert/strict";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  makeGuestContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const lookupRemoteFollowerQuery = parse(`
  query LookupRemoteFollower($actorId: ID!, $followerHandle: String!) {
    lookupRemoteFollower(actorId: $actorId, followerHandle: $followerHandle) {
      preferredUsername
      handle
      domain
      software
      url
      remoteFollowUrl
    }
  }
`);

test("lookupRemoteFollower builds a fallback result from WebFinger data", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "lookupactor",
      name: "Lookup Actor",
      email: "lookupactor@example.com",
    });
    const fedCtx = createFedCtx(tx);
    fedCtx.lookupWebFinger = () =>
      Promise.resolve({
        links: [
          {
            rel: "self",
            type: "application/activity+json",
            href: "https://remote.example/users/alice",
          },
          {
            rel: "http://ostatus.org/schema/1.0/subscribe",
            template: "https://remote.example/authorize?uri={uri}",
          },
        ],
      });
    fedCtx.lookupObject = () => Promise.reject(new Error("lookup failed"));
    fedCtx.getDocumentLoader = () => Promise.resolve({}) as never;

    const result = await execute({
      schema,
      document: lookupRemoteFollowerQuery,
      variableValues: {
        actorId: encodeGlobalID("Actor", actor.actor.id),
        followerHandle: "@alice@remote.example",
      },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      lookupRemoteFollower: {
        preferredUsername: "alice",
        handle: "alice@remote.example",
        domain: "remote.example",
        software: "unknown",
        url: "https://remote.example/users/alice",
        remoteFollowUrl: `https://remote.example/authorize?uri=${
          encodeURIComponent(actor.actor.handle)
        }`,
      },
    });
  });
});

test("lookupRemoteFollower returns null for invalid handles", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "invalidlookupactor",
      name: "Invalid Lookup Actor",
      email: "invalidlookupactor@example.com",
    });

    const result = await execute({
      schema,
      document: lookupRemoteFollowerQuery,
      variableValues: {
        actorId: encodeGlobalID("Actor", actor.actor.id),
        followerHandle: "not-a-fediverse-handle",
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), { lookupRemoteFollower: null });
  });
});
