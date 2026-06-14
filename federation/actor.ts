import process from "node:process";
import { exportJwk, generateCryptoKeyPair, importJwk } from "@fedify/fedify";
import { Application, Endpoints, Image } from "@fedify/vocab";
import { accountKeyTable, type NewAccountKey } from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { builder } from "./builder.ts";
import { getAccountActor } from "./person.ts";

const INSTANCE_ACTOR_KEY = process.env.INSTANCE_ACTOR_KEY;
if (INSTANCE_ACTOR_KEY == null) {
  throw new Error("INSTANCE_ACTOR_KEY is required");
}
const INSTANCE_ACTOR_KEY_JWK = JSON.parse(INSTANCE_ACTOR_KEY);
if (INSTANCE_ACTOR_KEY_JWK.kty !== "RSA") {
  throw new Error("INSTANCE_ACTOR_KEY must be an RSA key");
}
const INSTANCE_ACTOR_KEY_PAIR: CryptoKeyPair = {
  privateKey: await importJwk(INSTANCE_ACTOR_KEY_JWK, "private"),
  publicKey: await importJwk({
    kty: INSTANCE_ACTOR_KEY_JWK.kty,
    alg: INSTANCE_ACTOR_KEY_JWK.alg,
    e: INSTANCE_ACTOR_KEY_JWK.e,
    n: INSTANCE_ACTOR_KEY_JWK.n,
    key_ops: ["verify"],
  }, "public"),
};

builder
  .setActorDispatcher(
    "/ap/actors/{identifier}",
    async (ctx, identifier) => {
      if (identifier == new URL(ctx.canonicalOrigin).hostname) {
        // Instance actor:
        const keys = await ctx.getActorKeyPairs(identifier);
        return new Application({
          id: ctx.getActorUri(identifier),
          preferredUsername: identifier,
          name: "Hackers' Pub",
          summary: "An instance actor for Hackers' Pub.",
          manuallyApprovesFollowers: true,
          inbox: ctx.getInboxUri(identifier),
          outbox: ctx.getOutboxUri(identifier),
          endpoints: new Endpoints({
            sharedInbox: ctx.getInboxUri(),
          }),
          following: ctx.getFollowingUri(identifier),
          followers: ctx.getFollowersUri(identifier),
          featured: ctx.getFeaturedUri(identifier),
          icon: new Image({
            url: new URL("/favicon.svg", ctx.canonicalOrigin),
          }),
          publicKey: keys[0].cryptographicKey,
          assertionMethods: keys.map((pair) => pair.multikey),
        });
      }

      if (!validateUuid(identifier)) return null;
      const account = await ctx.data.db.query.accountTable.findFirst({
        where: { id: identifier },
        with: {
          actor: true,
          avatarMedium: true,
          emails: true,
          links: { orderBy: { index: "asc" } },
        },
      });
      if (account == null) return null;
      const keys = await ctx.getActorKeyPairs(identifier);
      return await getAccountActor(ctx, account, keys);
    },
  )
  .mapHandle(async (ctx, handle) => {
    if (handle === new URL(ctx.canonicalOrigin).hostname) return handle;
    const account = await ctx.data.db.query.accountTable.findFirst({
      where: { username: handle },
    });
    return account == null ? null : account.id;
  })
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    if (identifier === new URL(ctx.canonicalOrigin).hostname) {
      // Instance actor:
      return [INSTANCE_ACTOR_KEY_PAIR];
    }

    if (!validateUuid(identifier)) return [];
    let keyRecords = await ctx.data.db.query.accountKeyTable.findMany({
      where: { accountId: identifier },
    });
    const existingTypes = new Set(keyRecords.map((r) => r.type));
    const newRecords: NewAccountKey[] = [];
    if (!existingTypes.has("RSASSA-PKCS1-v1_5")) {
      const { publicKey, privateKey } = await generateCryptoKeyPair(
        "RSASSA-PKCS1-v1_5",
      );
      newRecords.push({
        accountId: identifier,
        type: "RSASSA-PKCS1-v1_5",
        public: await exportJwk(publicKey),
        private: await exportJwk(privateKey),
      });
    }
    if (!existingTypes.has("Ed25519")) {
      const { publicKey, privateKey } = await generateCryptoKeyPair("Ed25519");
      newRecords.push({
        accountId: identifier,
        type: "Ed25519",
        public: await exportJwk(publicKey),
        private: await exportJwk(privateKey),
      });
    }
    if (newRecords.length > 0) {
      // Use onConflictDoNothing to tolerate concurrent inserts racing on the
      // (account_id, type) primary key, then re-fetch so we observe whatever
      // the winning transaction wrote.
      await ctx.data.db.insert(accountKeyTable).values(newRecords)
        .onConflictDoNothing();
      keyRecords = await ctx.data.db.query.accountKeyTable.findMany({
        where: { accountId: identifier },
      });
    }
    keyRecords.sort((a, b) => a.type < b.type ? 1 : a.type > b.type ? -1 : 0);
    return Promise.all(
      keyRecords.map(async (key) => ({
        privateKey: await importJwk(key.private, "private"),
        publicKey: await importJwk(key.public, "public"),
      })),
    );
  });
