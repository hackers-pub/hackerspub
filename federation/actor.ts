import process from "node:process";
import {
  type ActorKeyPair,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
} from "@fedify/fedify";
import {
  Application,
  Endpoints,
  Group,
  Image,
  Organization,
  Person,
  Service,
  Tombstone,
} from "@fedify/vocab";
import {
  type AccountKey,
  accountKeyTable,
  type ActorType,
  type DeletedAccountKey,
  type NewAccountKey,
} from "@hackerspub/models/schema";
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

type StoredActorKey = Pick<
  AccountKey | DeletedAccountKey,
  "type" | "public" | "private"
>;

type TombstoneFormerType =
  | typeof Application
  | typeof Group
  | typeof Organization
  | typeof Person
  | typeof Service;

function sortStoredActorKeys<T extends StoredActorKey>(keys: T[]): T[] {
  return [...keys].sort((a, b) =>
    a.type < b.type ? 1 : a.type > b.type ? -1 : 0
  );
}

function getTombstoneFormerType(actorType: ActorType): TombstoneFormerType {
  switch (actorType) {
    case "Application":
      return Application;
    case "Group":
      return Group;
    case "Organization":
      return Organization;
    case "Service":
      return Service;
    case "Person":
    default:
      return Person;
  }
}

async function importStoredActorKeys(
  keyRecords: StoredActorKey[],
): Promise<CryptoKeyPair[]> {
  return await Promise.all(
    sortStoredActorKeys(keyRecords).map(async (key) => ({
      privateKey: await importJwk(key.private, "private"),
      publicKey: await importJwk(key.public, "public"),
    })),
  );
}

class KeyedTombstone extends Tombstone {
  readonly #keys: ActorKeyPair[];

  constructor(
    values: ConstructorParameters<typeof Tombstone>[0],
    keys: ActorKeyPair[],
  ) {
    super(values);
    this.#keys = keys;
  }

  override async toJsonLd(
    options: Parameters<Tombstone["toJsonLd"]>[0] = {},
  ): Promise<unknown> {
    const jsonLd = await super.toJsonLd(options);
    if (
      this.#keys.length < 1 || jsonLd == null || typeof jsonLd !== "object" ||
      Array.isArray(jsonLd)
    ) {
      return jsonLd;
    }
    const result = jsonLd as Record<string, unknown>;
    result.publicKey = await this.#keys[0].cryptographicKey.toJsonLd(options);
    result.assertionMethod = await Promise.all(
      this.#keys.map((pair) => pair.multikey.toJsonLd(options)),
    );
    return result;
  }
}

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
      if (account == null) {
        const deleted = await ctx.data.db.query.deletedAccountTable.findFirst({
          where: { accountId: identifier },
        });
        if (deleted == null) return null;
        const keys = await ctx.getActorKeyPairs(identifier);
        return new KeyedTombstone(
          {
            id: ctx.getActorUri(identifier),
            formerType: getTombstoneFormerType(deleted.formerType),
            deleted: Temporal.Instant.fromEpochMilliseconds(
              deleted.deleted.getTime(),
            ),
          },
          keys,
        );
      }
      const keys = await ctx.getActorKeyPairs(identifier);
      return await getAccountActor(ctx, account, keys);
    },
  )
  .mapHandle(async (ctx, handle) => {
    if (handle === new URL(ctx.canonicalOrigin).hostname) return handle;
    const account = await ctx.data.db.query.accountTable.findFirst({
      where: { username: handle },
    });
    if (account != null) return account.id;
    const deleted = await ctx.data.db.query.deletedAccountTable.findFirst({
      where: { username: handle },
    });
    return deleted == null ? null : deleted.accountId;
  })
  .setKeyPairsDispatcher(async (ctx, identifier) => {
    if (identifier === new URL(ctx.canonicalOrigin).hostname) {
      // Instance actor:
      return [INSTANCE_ACTOR_KEY_PAIR];
    }

    if (!validateUuid(identifier)) return [];
    const deletedKeyRecords = await ctx.data.db.query.deletedAccountKeyTable
      .findMany({
        where: { accountId: identifier },
      });
    if (deletedKeyRecords.length > 0) {
      return await importStoredActorKeys(deletedKeyRecords);
    }
    const deleted = await ctx.data.db.query.deletedAccountTable.findFirst({
      where: { accountId: identifier },
      columns: { accountId: true },
    });
    if (deleted != null) return [];

    let keyRecords = await ctx.data.db.query.accountKeyTable.findMany({
      where: { accountId: identifier },
    });
    const account = await ctx.data.db.query.accountTable.findFirst({
      where: { id: identifier },
      columns: { id: true },
    });
    if (account == null) return [];
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
    return await importStoredActorKeys(keyRecords);
  });
