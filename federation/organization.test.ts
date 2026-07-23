import assert from "node:assert";
import test from "node:test";
import {
  exportJwk,
  generateCryptoKeyPair,
  MemoryKvStore,
  type MessageQueue,
} from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import {
  acceptOrganizationConversion,
  requestOrganizationConversion,
} from "@hackerspub/models/organization";
import { followingTable } from "@hackerspub/models/schema";
import {
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  insertRemoteActor,
  services,
  withRollback,
} from "../test/postgres.ts";
import { toApplicationContext } from "./context.ts";

let federationBuilderPromise:
  | Promise<typeof import("./mod.ts").builder>
  | undefined;

async function getFederationBuilder() {
  if (federationBuilderPromise == null) {
    federationBuilderPromise = (async () => {
      const { privateKey } = await generateCryptoKeyPair(
        "RSASSA-PKCS1-v1_5",
      );
      Deno.env.set(
        "INSTANCE_ACTOR_KEY",
        JSON.stringify(
          await exportJwk(privateKey),
        ),
      );
      return (await import("./mod.ts")).builder;
    })();
  }
  return await federationBuilderPromise;
}

test("acceptOrganizationConversion() enqueues Update(Organization) through Fedify", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "convertfedify",
      name: "Convert Fedify",
      email: "convertfedify@example.com",
    });
    const admin = await insertAccountWithActor(tx, {
      username: "convertfedifyadmin",
      name: "Convert Fedify Admin",
      email: "convertfedifyadmin@example.com",
    });
    const follower = await insertRemoteActor(tx, {
      username: "convertfedifyfollower",
      name: "Convert Fedify Follower",
      host: "remote.example",
    });
    await tx.insert(followingTable).values({
      iri: "https://remote.example/follows/convert-fedify",
      followerId: follower.id,
      followeeId: account.actor.id,
      accepted: new Date("2026-04-15T00:00:00.000Z"),
    });
    const request = await requestOrganizationConversion(
      tx,
      account.account,
      admin.account.username,
      account.account.username,
    );
    const queued: unknown[] = [];
    const queue: MessageQueue = {
      enqueue(message) {
        queued.push(message);
        return Promise.resolve();
      },
      enqueueMany(messages) {
        queued.push(...messages);
        return Promise.resolve();
      },
      listen() {
        return new Promise(() => {});
      },
    };
    const builder = await getFederationBuilder();
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      queue,
      manuallyStartQueue: true,
      origin: "http://localhost/",
    });
    const { kv } = createTestKv();
    const fedCtx = federation.createContext(
      new Request("http://localhost/graphql"),
      {
        db: tx,
        kv,
        disk: createTestDisk(),
        models: {} as ContextData["models"],
        services,
      },
    );

    await acceptOrganizationConversion(
      toApplicationContext(fedCtx),
      admin.account,
      request.id,
    );

    assert.equal(queued.length, 1);
  });
});
