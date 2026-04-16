import assert from "node:assert/strict";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { follow } from "@hackerspub/models/following";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const actorByUuidQuery = parse(`
  query ActorByUuid($uuid: UUID!) {
    actorByUuid(uuid: $uuid) {
      id
      handle
    }
  }
`);

const actorByHandleQuery = parse(`
  query ActorByHandle($handle: String!, $allowLocalHandle: Boolean!) {
    actorByHandle(handle: $handle, allowLocalHandle: $allowLocalHandle) {
      id
      handle
    }
  }
`);

const instanceByHostQuery = parse(`
  query InstanceByHost($host: String!) {
    instanceByHost(host: $host) {
      host
      software
    }
  }
`);

const searchActorsByHandleQuery = parse(`
  query SearchActorsByHandle($prefix: String!, $limit: Int!) {
    searchActorsByHandle(prefix: $prefix, limit: $limit) {
      handle
    }
  }
`);

const recommendedActorsQuery = parse(`
  query RecommendedActors($limit: Int!, $locale: Locale) {
    recommendedActors(limit: $limit, locale: $locale) {
      handle
    }
  }
`);

test("actorByUuid and actorByHandle resolve local actors", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "actorlookupgraphql",
      name: "Actor Lookup GraphQL",
      email: "actorlookupgraphql@example.com",
    });

    const byUuid = await execute({
      schema,
      document: actorByUuidQuery,
      variableValues: { uuid: actor.actor.id },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(byUuid.errors, undefined);
    assert.deepEqual(toPlainJson(byUuid.data), {
      actorByUuid: {
        id: encodeGlobalID("Actor", actor.actor.id),
        handle: "@actorlookupgraphql@localhost",
      },
    });

    const byHandle = await execute({
      schema,
      document: actorByHandleQuery,
      variableValues: {
        handle: actor.account.username,
        allowLocalHandle: true,
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(byHandle.errors, undefined);
    assert.deepEqual(toPlainJson(byHandle.data), {
      actorByHandle: {
        id: encodeGlobalID("Actor", actor.actor.id),
        handle: "@actorlookupgraphql@localhost",
      },
    });
  });
});

test("instanceByHost and searchActorsByHandle expose lookup results", async () => {
  await withRollback(async (tx) => {
    const local = await insertAccountWithActor(tx, {
      username: "actorsearchlocal",
      name: "Actor Search Local",
      email: "actorsearchlocal@example.com",
    });
    const remote = await insertRemoteActor(tx, {
      username: "actorsearchremote",
      name: "Actor Search Remote",
      host: "remote.example",
    });

    const instance = await execute({
      schema,
      document: instanceByHostQuery,
      variableValues: { host: "remote.example" },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(instance.errors, undefined);
    assert.deepEqual(toPlainJson(instance.data), {
      instanceByHost: {
        host: "remote.example",
        software: "hackerspub",
      },
    });

    const search = await execute({
      schema,
      document: searchActorsByHandleQuery,
      variableValues: { prefix: "actorsearch", limit: 10 },
      contextValue: makeUserContext(tx, local.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(search.errors, undefined);
    const handles = (toPlainJson(search.data) as {
      searchActorsByHandle: Array<{ handle: string }>;
    }).searchActorsByHandle.map((actor) => actor.handle);

    assert.ok(handles.includes("@actorsearchlocal@localhost"));
    assert.ok(handles.includes(`@${remote.username}@${remote.handleHost}`));
  });
});

test("recommendedActors excludes followed actors and filters by locale", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "actorrecommendviewer",
      name: "Actor Recommend Viewer",
      email: "actorrecommendviewer@example.com",
    });
    const localCandidate = await insertAccountWithActor(tx, {
      username: "actorrecommendlocal",
      name: "Actor Recommend Local",
      email: "actorrecommendlocal@example.com",
    });
    const followedCandidate = await insertAccountWithActor(tx, {
      username: "actorrecommendfollowed",
      name: "Actor Recommend Followed",
      email: "actorrecommendfollowed@example.com",
    });
    const remoteCandidate = await insertRemoteActor(tx, {
      username: "actorrecommendremote",
      name: "Actor Recommend Remote",
      host: "remote.example",
    });
    await insertNotePost(tx, {
      account: localCandidate.account,
      language: "en",
      content: "Recommended local post",
    });
    await insertNotePost(tx, {
      account: followedCandidate.account,
      language: "en",
      content: "Recommended followed post",
    });
    await insertRemotePost(tx, {
      actorId: remoteCandidate.id,
      language: "ja",
      contentHtml: "<p>Japanese remote post</p>",
    });

    const fedCtx = createFedCtx(tx);
    await follow(fedCtx, viewer.account, followedCandidate.actor);

    const result = await execute({
      schema,
      document: recommendedActorsQuery,
      variableValues: { limit: 10, locale: "en-US" },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const handles = (toPlainJson(result.data) as {
      recommendedActors: Array<{ handle: string }>;
    }).recommendedActors.map((actor) => actor.handle);

    assert.ok(handles.includes("@actorrecommendlocal@localhost"));
    assert.ok(!handles.includes("@actorrecommendfollowed@localhost"));
    assert.ok(!handles.includes("@actorrecommendremote@remote.example"));
  });
});
