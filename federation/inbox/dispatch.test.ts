import assert from "node:assert";
import { describe, it } from "node:test";
import type { InboxContext } from "@fedify/fedify";
import type { Accept, Delete, Follow, Reject } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../../test/postgres.ts";
import {
  onAccepted,
  onDeleted,
  onFollowReceived,
  onRejected,
} from "./dispatch.ts";

describe("transactional inbox dispatch", () => {
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
