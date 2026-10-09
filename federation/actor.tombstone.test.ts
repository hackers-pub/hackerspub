import assert from "node:assert";
import process from "node:process";
import test from "node:test";
import {
  exportJwk,
  generateCryptoKeyPair,
  MemoryKvStore,
} from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import {
  accountKeyTable,
  deletedAccountKeyTable,
  deletedAccountTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { postgres } from "../test/database.ts";
import {
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  services,
  withRollback,
} from "../test/postgres.ts";

let builderPromise: Promise<typeof import("./mod.ts").builder> | undefined;

async function getBuilder(): Promise<typeof import("./mod.ts").builder> {
  if (builderPromise == null) {
    builderPromise = (async () => {
      const { privateKey } = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
      process.env.INSTANCE_ACTOR_KEY = JSON.stringify(
        await exportJwk(privateKey),
      );
      return (await import("./mod.ts")).builder;
    })();
  }
  return await builderPromise;
}

test("actor dispatcher returns a Tombstone for a deleted account", async () => {
  await withRollback(async (tx) => {
    const accountId = generateUuidV7();
    await tx.insert(deletedAccountTable).values({
      accountId,
      username: "deletedactor",
      actorIri: `http://localhost/ap/actors/${accountId}`,
      deleted: new Date("2026-06-17T00:00:00.000Z"),
    });
    const builder = await getBuilder();
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db: tx,
      kv: createTestKv().kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
      services,
    };

    const response = await federation.fetch(
      new Request(`http://localhost/ap/actors/${accountId}`, {
        headers: { Accept: "application/activity+json" },
      }),
      { contextData },
    );

    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.type, "Tombstone");
    assert.equal(body.id, `http://localhost/ap/actors/${accountId}`);
    assert.equal(body.formerType, "as:Person");
  });
});

test("key dispatch loads account state and stored keys in one query", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "keydispatchbatch",
      name: "Key dispatch batch",
      email: "keydispatchbatch@example.com",
    });
    for (const type of ["RSASSA-PKCS1-v1_5", "Ed25519"] as const) {
      const pair = await generateCryptoKeyPair(type);
      await tx.insert(accountKeyTable).values({
        accountId: account.id,
        type,
        public: await exportJwk(pair.publicKey),
        private: await exportJwk(pair.privateKey),
      });
    }
    const deletedId = generateUuidV7();
    await tx.insert(deletedAccountTable).values({
      accountId: deletedId,
      username: "keydispatchdeleted",
      actorIri: `http://localhost/ap/actors/${deletedId}`,
    });
    const builder = await getBuilder();
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      for (const [identifier, expectedKeys] of [
        [account.id, 2],
        [deletedId, 0],
        [generateUuidV7(), 0],
      ] as const) {
        const ctx = federation.createContext(new URL("http://localhost/"), {
          db: tx,
          kv: createTestKv().kv,
          disk: createTestDisk(),
          models: {} as ContextData["models"],
          services,
        });
        queries.length = 0;
        const keys = await ctx.getActorKeyPairs(identifier);
        assert.equal(keys.length, expectedKeys);
        assert.equal(
          queries.length,
          1,
          "Stored-key dispatch must use one SQL query",
        );
        if (expectedKeys === 2) {
          assert.deepEqual(
            keys.map((key) => key.publicKey.algorithm.name),
            ["RSASSA-PKCS1-v1_5", "Ed25519"],
          );
        }
      }
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("actor dispatcher preserves an Organization deleted actor type", async () => {
  await withRollback(async (tx) => {
    const accountId = generateUuidV7();
    await tx.insert(deletedAccountTable).values({
      accountId,
      username: "deletedorg",
      actorIri: `http://localhost/ap/actors/${accountId}`,
      formerType: "Organization",
      deleted: new Date("2026-06-17T00:00:00.000Z"),
    });
    const builder = await getBuilder();
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db: tx,
      kv: createTestKv().kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
      services,
    };

    const response = await federation.fetch(
      new Request(`http://localhost/ap/actors/${accountId}`, {
        headers: { Accept: "application/activity+json" },
      }),
      { contextData },
    );

    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.type, "Tombstone");
    assert.equal(body.formerType, "as:Organization");
  });
});

test("key dispatch generates missing types and honors deletion precedence", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "keydispatchmissing",
      name: "Key dispatch missing",
      email: "keydispatchmissing@example.com",
    });
    const pair = await generateCryptoKeyPair("Ed25519");
    const publicJwk = await exportJwk(pair.publicKey);
    await tx.insert(accountKeyTable).values({
      accountId: account.id,
      type: "Ed25519",
      public: publicJwk,
      private: await exportJwk(pair.privateKey),
    });
    const builder = await getBuilder();
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db: tx,
      kv: createTestKv().kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
      services,
    };
    const getKeys = () =>
      federation
        .createContext(new URL("http://localhost/"), contextData)
        .getActorKeyPairs(account.id);
    const keys = await getKeys();
    assert.equal(keys.length, 2);
    assert.deepEqual(await exportJwk(keys[1].publicKey), publicJwk);
    assert.equal(
      (
        await tx.query.accountKeyTable.findMany({
          where: { accountId: account.id },
        })
      ).length,
      2,
    );

    // A tombstone takes precedence even if a live account is also visible.
    await tx.insert(deletedAccountTable).values({
      accountId: account.id,
      username: "keydispatchretired",
      actorIri: `http://localhost/ap/actors/${account.id}`,
    });
    assert.equal((await getKeys()).length, 0);
    await tx.insert(deletedAccountKeyTable).values({
      accountId: account.id,
      type: "Ed25519",
      public: publicJwk,
      private: await exportJwk(pair.privateKey),
    });
    const deletedKeys = await getKeys();
    assert.equal(deletedKeys.length, 1);
    assert.deepEqual(await exportJwk(deletedKeys[0].publicKey), publicJwk);
  });
});

test("actor dispatcher preserves deleted actor public keys", async () => {
  await withRollback(async (tx) => {
    const accountId = generateUuidV7();
    const { publicKey, privateKey } =
      await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
    await tx.insert(deletedAccountTable).values({
      accountId,
      username: "deletedkeyed",
      actorIri: `http://localhost/ap/actors/${accountId}`,
      deleted: new Date("2026-06-17T00:00:00.000Z"),
    });
    await tx.insert(deletedAccountKeyTable).values({
      accountId,
      type: "RSASSA-PKCS1-v1_5",
      public: await exportJwk(publicKey),
      private: await exportJwk(privateKey),
    });
    const builder = await getBuilder();
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db: tx,
      kv: createTestKv().kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
      services,
    };

    const response = await federation.fetch(
      new Request(`http://localhost/ap/actors/${accountId}`, {
        headers: { Accept: "application/activity+json" },
      }),
      { contextData },
    );

    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.type, "Tombstone");
    assert.equal(
      body.publicKey?.owner,
      `http://localhost/ap/actors/${accountId}`,
    );
    assert.equal(
      body.publicKey?.id,
      `http://localhost/ap/actors/${accountId}#main-key`,
    );
  });
});

test("WebFinger maps a deleted username to the Tombstone actor", async () => {
  await withRollback(async (tx) => {
    const accountId = generateUuidV7();
    await tx.insert(deletedAccountTable).values({
      accountId,
      username: "deletedhandle",
      actorIri: `http://localhost/ap/actors/${accountId}`,
      deleted: new Date("2026-06-17T00:00:00.000Z"),
    });
    const builder = await getBuilder();
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db: tx,
      kv: createTestKv().kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
      services,
    };

    const response = await federation.fetch(
      new Request(
        "http://localhost/.well-known/webfinger?resource=acct:deletedhandle@localhost",
      ),
      { contextData },
    );

    assert.equal(response.status, 410);
  });
});
