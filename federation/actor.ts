import {
  Endpoints,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
  Person,
} from "@fedify/fedify";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import {
  accountKeyTable,
  accountTable,
  NewAccountKey,
} from "../models/schema.ts";
import { validateUuid } from "../utils.ts";
import { federation } from "./federation.ts";
import { renderMarkup } from "../models/markup.ts";
import { kv } from "../kv.ts";

federation
  .setActorDispatcher(
    "/ap/actors/{identifier}",
    async (ctx, identifier) => {
      if (!validateUuid(identifier)) return null;
      const account = await db.query.accountTable.findFirst({
        where: eq(accountTable.id, identifier),
      });
      if (account == null) return null;
      const bio = await renderMarkup(kv, account.bio);
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
        endpoints: new Endpoints({
          sharedInbox: ctx.getInboxUri(),
        }),
      });
    },
  )
  .mapHandle(async (_ctx, handle) => {
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, handle),
    });
    return account == null ? null : account.id;
  })
  .setKeyPairsDispatcher(async (_ctx, identifier) => {
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
