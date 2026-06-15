import assert from "node:assert";
import test from "node:test";
import type { InboxContext } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import { createFedCtx, withRollback } from "../../test/postgres.ts";
import { onUpdated } from "./update.ts";

test("onUpdated ignores invalid remote objects", async () => {
  await withRollback(async (tx) => {
    const update = new vocab.Update({
      id: new URL("https://remote.example/activities/update/1"),
      actor: new URL("https://remote.example/users/alice"),
      object: new URL("https://remote.example/objects/bad"),
    });
    let objectFetches = 0;
    Object.defineProperty(update, "getObject", {
      value: () => {
        objectFetches++;
        throw new TypeError("Expected object to be an ActivityPub object.");
      },
    });

    await onUpdated(
      createFedCtx(tx) as unknown as InboxContext<ContextData>,
      update,
    );

    assert.equal(objectFetches, 1);
  });
});

test("onUpdated does not refetch an already loaded actor object", async () => {
  await withRollback(async (tx) => {
    const actorObject = new vocab.Person({
      id: new URL("https://remote.example/users/alice"),
      preferredUsername: "alice",
      name: "Alice Remote",
      inbox: new URL("https://remote.example/users/alice/inbox"),
      url: new URL("https://remote.example/@alice"),
    });
    const update = new vocab.Update({
      id: new URL("https://remote.example/activities/update/2"),
      actor: actorObject.id,
      object: actorObject,
    });
    let objectFetches = 0;
    Object.defineProperty(update, "getObject", {
      value: () => {
        objectFetches++;
        if (objectFetches > 1) throw new Error("unexpected object refetch");
        return actorObject;
      },
    });

    await onUpdated(
      createFedCtx(tx) as unknown as InboxContext<ContextData>,
      update,
    );

    assert.equal(objectFetches, 1);
    const actor = await tx.query.actorTable.findFirst({
      where: { iri: actorObject.id?.href },
    });
    assert.ok(actor != null);
  });
});
