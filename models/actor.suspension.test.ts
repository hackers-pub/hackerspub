import assert from "node:assert";
import test from "node:test";
import * as vocab from "@fedify/vocab";
import { persistActor } from "@hackerspub/models/actor";
import { persistReaction } from "@hackerspub/models/reaction";
import { actorTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

const HOUR = 60 * 60 * 1000;

function alice(): vocab.Person {
  return new vocab.Person({
    id: new URL("https://remote.example/users/alice"),
    preferredUsername: "alice",
    name: "Alice Remote",
    inbox: new URL("https://remote.example/users/alice/inbox"),
    url: new URL("https://remote.example/@alice"),
  });
}

test("persistActor() drops actors under an active federation block", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const existing = await insertRemoteActor(tx, {
      username: "alice",
      name: "Alice Remote",
      host: "remote.example",
      iri: "https://remote.example/users/alice",
    });
    await tx.update(actorTable)
      .set({
        suspended: new Date(Date.now() - HOUR),
        suspendedUntil: new Date(Date.now() + HOUR),
      })
      .where(eq(actorTable.id, existing.id));

    // Activities from the blocked actor are dropped at the persist
    // choke point: handlers bail when the actor fails to persist.
    const dropped = await persistActor(fedCtx, alice(), { outbox: false });
    assert.equal(dropped, undefined);

    // The cached profile stays frozen during the block:
    const frozen = await tx.query.actorTable.findFirst({
      where: { id: existing.id },
    });
    assert.equal(frozen?.name, "Alice Remote");
  });
});

test("persistActor() resumes after the federation block expires", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const existing = await insertRemoteActor(tx, {
      username: "alice",
      name: "Alice Remote",
      host: "remote.example",
      iri: "https://remote.example/users/alice",
    });
    await tx.update(actorTable)
      .set({
        suspended: new Date(Date.now() - 2 * HOUR),
        suspendedUntil: new Date(Date.now() - HOUR),
      })
      .where(eq(actorTable.id, existing.id));
    const persisted = await persistActor(fedCtx, alice(), { outbox: false });
    assert.ok(persisted != null);
    assert.equal(persisted.id, existing.id);
  });
});

test("cached federation-blocked actors cannot react", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const blocked = await insertRemoteActor(tx, {
      username: "blocked",
      name: "Blocked",
      host: "remote.example",
      iri: "https://remote.example/users/blocked",
    });
    await tx.update(actorTable)
      .set({ suspended: new Date(Date.now() - HOUR) })
      .where(eq(actorTable.id, blocked.id));
    const author = await insertAccountWithActor(tx, {
      username: "author",
      name: "Author",
      email: "author@example.com",
    });
    const { post } = await insertNotePost(tx, { account: author.account });

    // The actor row is cached, so persistActor never runs; the write
    // accept points must drop the activity themselves.
    const reaction = await persistReaction(
      fedCtx,
      new vocab.Like({
        id: new URL("https://remote.example/likes/1"),
        actor: new URL(blocked.iri),
        object: new URL(post.iri),
      }),
      {},
    );
    assert.equal(reaction, undefined);
  });
});
