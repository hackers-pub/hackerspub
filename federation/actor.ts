import {
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

federation
  .setActorDispatcher(
    "/ap/actors/{identifier}",
    async (ctx, identifier) => {
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
  .mapHandle(async (_ctx, handle) => {
    const account = await db.query.accountTable.findFirst({
      where: eq(accountTable.username, handle),
    });
    return account == null ? null : account.id;
  })
  .setKeyPairsDispatcher(async (_ctx, identifier) => {
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
