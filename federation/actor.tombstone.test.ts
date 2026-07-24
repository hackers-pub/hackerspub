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
  deletedAccountKeyTable,
  deletedAccountTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import {
  createTestDisk,
  createTestKv,
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
