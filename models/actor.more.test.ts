import assert from "node:assert/strict";
import test from "node:test";
import * as vocab from "@fedify/vocab";
import {
  persistActor,
  persistActorsByHandles,
  recommendActors,
  toRecipient,
} from "./actor.ts";
import { follow } from "./following.ts";
import {
  createFedCtx,
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

test("persistActor() stores a remote actor and toRecipient() reflects inbox endpoints", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const actorObject = new vocab.Person({
      id: new URL("https://remote.example/users/alice"),
      preferredUsername: "alice",
      name: "Alice Remote",
      inbox: new URL("https://remote.example/users/alice/inbox"),
      followers: new URL("https://remote.example/users/alice/followers"),
      endpoints: new vocab.Endpoints({
        sharedInbox: new URL("https://remote.example/inbox"),
      }),
      url: new URL("https://remote.example/@alice"),
    });

    const actor = await persistActor(fedCtx, actorObject, { outbox: false });

    assert.ok(actor != null);
    assert.equal(actor.username, "alice");
    assert.equal(actor.instance.host, "remote.example");
    assert.equal(actor.handle, "@alice@remote.example");
    assert.equal(actor.account, null);

    const recipient = toRecipient(actor);
    assert.ok(recipient.id != null);
    assert.ok(recipient.inboxId != null);
    assert.equal(recipient.id.href, actor.iri);
    assert.equal(recipient.inboxId.href, actor.inboxUrl);
    assert.equal(recipient.endpoints?.sharedInbox?.href, actor.sharedInboxUrl);
  });
});

test("persistActorsByHandles() fetches missing handles and returns cached actors on repeat", async () => {
  await withRollback(async (tx) => {
    const { kv, store } = createTestKv();
    const extendedKv = {
      ...kv,
      getMany(keys: string[]) {
        return Promise.resolve(keys.map((key) => store.get(key)));
      },
    } as typeof kv;
    const fedCtx = createFedCtx(tx, { kv: extendedKv });
    let lookups = 0;
    fedCtx.getDocumentLoader = () => Promise.resolve({}) as never;
    fedCtx.lookupObject = (handle: string) => {
      lookups += 1;
      if (handle !== "@bob@remote.example") return Promise.resolve(null);
      return Promise.resolve(
        new vocab.Person({
          id: new URL("https://remote.example/users/bob"),
          preferredUsername: "bob",
          name: "Bob Remote",
          inbox: new URL("https://remote.example/users/bob/inbox"),
          endpoints: new vocab.Endpoints({
            sharedInbox: new URL("https://remote.example/inbox"),
          }),
          url: new URL("https://remote.example/@bob"),
        }),
      );
    };

    const first = await persistActorsByHandles(fedCtx, ["@bob@remote.example"]);

    assert.equal(lookups, 1);
    assert.ok(first["@bob@remote.example"] != null);
    assert.equal(first["@bob@remote.example"].username, "bob");

    const second = await persistActorsByHandles(fedCtx, [
      "@bob@remote.example",
    ]);

    assert.equal(lookups, 1);
    assert.equal(
      second["@bob@remote.example"].id,
      first["@bob@remote.example"].id,
    );

    store.set("unreachable-handles/@ghost@remote.example", "1");
    const skipped = await persistActorsByHandles(fedCtx, [
      "@ghost@remote.example",
    ]);
    assert.deepEqual(skipped, {});
    assert.equal(lookups, 1);
  });
});

test("recommendActors() excludes followed actors and prefers matching locales", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "recommendviewer",
      name: "Recommend Viewer",
      email: "recommendviewer@example.com",
    });
    const localCandidate = await insertAccountWithActor(tx, {
      username: "recommendlocal",
      name: "Recommend Local",
      email: "recommendlocal@example.com",
    });
    const followedCandidate = await insertAccountWithActor(tx, {
      username: "recommendfollowed",
      name: "Recommend Followed",
      email: "recommendfollowed@example.com",
    });
    const remoteCandidate = await insertRemoteActor(tx, {
      username: "recommendremote",
      name: "Recommend Remote",
      host: "remote.example",
    });
    await insertRemotePost(tx, {
      actorId: remoteCandidate.id,
      language: "ja",
      contentHtml: "<p>Remote Japanese post</p>",
    });
    await insertNotePost(tx, {
      account: localCandidate.account,
      language: "en",
      content: "Local English post",
    });
    await insertNotePost(tx, {
      account: followedCandidate.account,
      language: "en",
      content: "Followed English post",
    });

    const fedCtx = createFedCtx(tx);
    await follow(fedCtx, viewer.account, followedCandidate.actor);

    const recommended = await recommendActors(tx, {
      account: viewer.account,
      mainLocale: "en-US",
      locales: ["en-US"],
      limit: 10,
    });

    assert.ok(
      recommended.some((actor) => actor.id === localCandidate.actor.id),
    );
    assert.ok(
      !recommended.some((actor) => actor.id === followedCandidate.actor.id),
    );
    assert.ok(!recommended.some((actor) => actor.id === remoteCandidate.id));
  });
});
