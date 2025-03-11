import {
  Application,
  Endpoints,
  exportJwk,
  generateCryptoKeyPair,
  Image,
  importJwk,
  Person,
} from "@fedify/fedify";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { getAvatarUrl, renderAccountLinks } from "../models/account.ts";
import { renderMarkup } from "../models/markup.ts";
import {
  accountKeyTable,
  accountLinkTable,
  accountTable,
  type NewAccountKey,
} from "../models/schema.ts";
import { validateUuid } from "../models/uuid.ts";
import { federation } from "./federation.ts";

const INSTANCE_ACTOR_KEY = Deno.env.get("INSTANCE_ACTOR_KEY");
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

federation
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
          followers: ctx.getFollowersUri(identifier),
          icon: new Image({
            url: new URL("/favicon.svg", ctx.canonicalOrigin),
          }),
          publicKey: keys[0].cryptographicKey,
          assertionMethods: keys.map((pair) => pair.multikey),
        });
      }

      if (!validateUuid(identifier)) return null;
      const account = await db.query.accountTable.findFirst({
        where: eq(accountTable.id, identifier),
        with: {
          emails: true,
          links: { orderBy: accountLinkTable.index },
        },
      });
      if (account == null) return null;
      const bio = await renderMarkup(db, ctx, account.id, account.bio);
      const keys = await ctx.getActorKeyPairs(identifier);
      return new Person({
        id: ctx.getActorUri(identifier),
        preferredUsername: account.username,
        name: account.name,
        summary: bio.html,
        manuallyApprovesFollowers: false,
        published: account.created.toTemporalInstant(),
        assertionMethods: keys.map((pair) => pair.multikey),
        publicKey: keys[0].cryptographicKey,
        inbox: ctx.getInboxUri(identifier),
        outbox: ctx.getOutboxUri(identifier),
        endpoints: new Endpoints({
          sharedInbox: ctx.getInboxUri(),
        }),
        icon: new Image({
          url: new URL(await getAvatarUrl(account)),
        }),
        attachments: renderAccountLinks(account.links),
        followers: ctx.getFollowersUri(identifier),
        url: new URL(`/@${account.username}`, ctx.canonicalOrigin),
      });
    },
  )
  .mapHandle(async (ctx, handle) => {
    if (handle === new URL(ctx.canonicalOrigin).hostname) return handle;
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, handle),
    });
    return account == null ? null : account.id;
  })
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    if (identifier === new URL(ctx.canonicalOrigin).hostname) {
      // Instance actor:
      return [INSTANCE_ACTOR_KEY_PAIR];
    }

    if (!validateUuid(identifier)) return [];
    const keyRecords = await db.query.accountKeyTable.findMany({
      where: eq(accountKeyTable.accountId, identifier),
    });
    const keys = new Map(keyRecords.map((r) => [r.type, r]));
    if (!keys.has("RSASSA-PKCS1-v1_5")) {
      const { publicKey, privateKey } = await generateCryptoKeyPair(
        "RSASSA-PKCS1-v1_5",
      );
      const records = await db.insert(accountKeyTable).values(
        {
          accountId: identifier,
          type: "RSASSA-PKCS1-v1_5",
          public: await exportJwk(publicKey),
          private: await exportJwk(privateKey),
        } satisfies NewAccountKey,
      ).returning();
      keyRecords.push(...records);
    }
    if (!keys.has("Ed25519")) {
      const { publicKey, privateKey } = await generateCryptoKeyPair("Ed25519");
      const records = await db.insert(accountKeyTable).values(
        {
          accountId: identifier,
          type: "Ed25519",
          public: await exportJwk(publicKey),
          private: await exportJwk(privateKey),
        } satisfies NewAccountKey,
      ).returning();
      keyRecords.push(...records);
    }
    keyRecords.sort((a, b) => a.type < b.type ? 1 : a.type > b.type ? -1 : 0);
    return Promise.all(
      keyRecords.map(async (key) => ({
        privateKey: await importJwk(key.private, "private"),
        publicKey: await importJwk(key.public, "public"),
      })),
    );
  });
