import { assert } from "@std/assert/assert";
import type { RequestContext } from "@fedify/fedify";
import { sql } from "drizzle-orm";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import type { Transport } from "@upyo/core";
import { MockLanguageModelV3 } from "ai/test";
import {
  accountEmailTable,
  accountTable,
  actorTable,
  type ActorType,
  instanceTable,
  mentionTable,
  type NewPost,
  noteSourceTable,
  type PostLink,
  postLinkTable,
  postTable,
  reactionTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import type { Uuid } from "@hackerspub/models/uuid";
import { db } from "../graphql/db.ts";
import type { UserContext } from "../graphql/builder.ts";

export type AuthenticatedAccount = NonNullable<UserContext["account"]>;

export interface TestKv {
  readonly store: Map<string, unknown>;
  readonly kv: UserContext["kv"];
}

export interface TestEmailTransport {
  readonly messages: unknown[];
  readonly transport: UserContext["email"];
}

export async function withRollback(
  run: (tx: Transaction) => Promise<void>,
): Promise<void> {
  let rolledBack = false;

  try {
    await db.transaction(async (tx) => {
      // Parallel rollback tests share fixture keys such as localhost.
      await tx.execute(sql`select pg_advisory_xact_lock(914441, 1)`);
      await run(tx);
      rolledBack = true;
      tx.rollback();
    });
  } catch (error) {
    if (!rolledBack) throw error;
  }
}

export async function seedLocalInstance(
  tx: Transaction,
  host = "localhost",
): Promise<void> {
  await tx.insert(instanceTable).values({
    host,
    software: "hackerspub",
    softwareVersion: "test",
  }).onConflictDoNothing();
}

/**
 * Seed (or override) an instance row with a specific `software` value, e.g.
 * `"mastodon"` or `"bsky.brid.gy"`, so news source-weight tests can control
 * how a remote actor's instance is classified.
 */
export async function seedInstance(
  tx: Transaction,
  host: string,
  software: string,
): Promise<void> {
  await tx.insert(instanceTable).values({
    host,
    software,
    softwareVersion: "test",
  }).onConflictDoUpdate({
    target: instanceTable.host,
    set: { software, softwareVersion: "test" },
  });
}

export async function insertAccountWithActor(
  tx: Transaction,
  values: {
    username: string;
    name: string;
    email: string;
    iri?: string;
    inboxUrl?: string;
    host?: string;
    kind?: "personal" | "organization";
    type?: ActorType;
    followersCount?: number;
    followeesCount?: number;
  },
): Promise<{
  account: AuthenticatedAccount;
  actor: AuthenticatedAccount["actor"];
}> {
  const accountId = generateUuidV7();
  const actorId = generateUuidV7();
  const timestamp = new Date("2026-04-15T00:00:00.000Z");
  const host = values.host ?? "localhost";

  await seedLocalInstance(tx, host);

  await tx.insert(accountTable).values({
    id: accountId,
    kind: values.kind ??
      (values.type === "Organization" ? "organization" : "personal"),
    username: values.username,
    name: values.name,
    bio: "",
    leftInvitations: 0,
    created: timestamp,
    updated: timestamp,
  });

  await tx.insert(accountEmailTable).values({
    email: values.email,
    accountId,
    public: false,
    verified: timestamp,
    created: timestamp,
  });

  await tx.insert(actorTable).values({
    id: actorId,
    iri: values.iri ?? `http://${host}/@${values.username}`,
    type: values.type ?? "Person",
    username: values.username,
    instanceHost: host,
    handleHost: host,
    accountId,
    name: values.name,
    followersCount: values.followersCount ?? 0,
    followeesCount: values.followeesCount ?? 0,
    inboxUrl: values.inboxUrl ?? `http://${host}/@${values.username}/inbox`,
    sharedInboxUrl: `http://${host}/inbox`,
    created: timestamp,
    updated: timestamp,
    published: timestamp,
  });

  const account = await tx.query.accountTable.findFirst({
    where: { id: accountId },
    with: {
      actor: true,
      avatarMedium: true,
      emails: true,
      links: true,
    },
  });

  assert(account != null);

  return {
    account: account as AuthenticatedAccount,
    actor: account.actor,
  };
}

export async function insertRemoteActor(
  tx: Transaction,
  values: {
    username: string;
    name: string;
    host: string;
    iri?: string;
    inboxUrl?: string;
    url?: string;
    handleHost?: string;
    type?: ActorType;
    followersCount?: number;
    followeesCount?: number;
  },
) {
  const actorId = generateUuidV7();
  const timestamp = new Date("2026-04-15T00:00:00.000Z");

  await seedLocalInstance(tx, values.host);

  await tx.insert(actorTable).values({
    id: actorId,
    iri: values.iri ?? `https://${values.host}/users/${values.username}`,
    type: values.type ?? "Person",
    username: values.username,
    instanceHost: values.host,
    handleHost: values.handleHost ?? values.host,
    name: values.name,
    followersCount: values.followersCount ?? 0,
    followeesCount: values.followeesCount ?? 0,
    inboxUrl: values.inboxUrl ??
      `https://${values.host}/users/${values.username}/inbox`,
    sharedInboxUrl: `https://${values.host}/inbox`,
    url: values.url,
    created: timestamp,
    updated: timestamp,
    published: timestamp,
  });

  const actor = await tx.query.actorTable.findFirst({ where: { id: actorId } });
  assert(actor != null);
  return actor;
}

export async function insertNotePost(
  tx: Transaction,
  values: {
    account: AuthenticatedAccount;
    actorId?: string;
    content?: string;
    contentHtml?: string;
    language?: string;
    visibility?: "public" | "unlisted" | "followers" | "direct" | "none";
    quotePolicy?: "everyone" | "followers" | "self";
    quoteRequestPolicy?: "everyone" | "followers" | "self";
    reactionsCounts?: Record<string, number>;
    repliesCount?: number;
    quotesCount?: number;
    sharesCount?: number;
    replyTargetId?: Uuid;
    quotedPostId?: Uuid;
    sharedPostId?: Uuid;
    link?: { id: Uuid; url: string };
    published?: Date;
    updated?: Date;
  },
) {
  const timestamp = values.published ?? new Date("2026-04-15T00:00:00.000Z");
  const updated = values.updated ?? timestamp;
  const noteSourceId = generateUuidV7();
  const noteId = generateUuidV7();

  await tx.insert(noteSourceTable).values({
    id: noteSourceId,
    accountId: values.account.id,
    visibility: values.visibility ?? "public",
    quotePolicy: values.quotePolicy ??
      ((values.visibility ?? "public") === "public" ||
          (values.visibility ?? "public") === "unlisted"
        ? "everyone"
        : "self"),
    content: values.content ?? "Hello world",
    language: values.language ?? "en",
    published: timestamp,
    updated,
  });

  const postValues: NewPost = {
    id: noteId,
    iri: `http://localhost/objects/${noteId}`,
    type: "Note",
    visibility: values.visibility ?? "public",
    quotePolicy: values.quotePolicy ??
      ((values.visibility ?? "public") === "public" ||
          (values.visibility ?? "public") === "unlisted"
        ? "everyone"
        : "self"),
    quoteRequestPolicy: values.quoteRequestPolicy,
    actorId: (values.actorId ?? values.account.actor.id) as Uuid,
    noteSourceId,
    sharedPostId: values.sharedPostId,
    replyTargetId: values.replyTargetId,
    quotedPostId: values.quotedPostId,
    linkId: values.link?.id,
    linkUrl: values.link?.url,
    contentHtml: values.contentHtml ??
      `<p>${values.content ?? "Hello world"}</p>`,
    language: values.language ?? "en",
    reactionsCounts: values.reactionsCounts ?? {},
    repliesCount: values.repliesCount,
    quotesCount: values.quotesCount,
    sharesCount: values.sharesCount,
    url: `http://localhost/@${values.account.username}/${noteSourceId}`,
    published: timestamp,
    updated,
  };

  await tx.insert(postTable).values(postValues);

  const post = await tx.query.postTable.findFirst({
    where: { id: noteId },
  });
  assert(post != null);

  return { noteSourceId, post };
}

export async function insertRemotePost(
  tx: Transaction,
  values: {
    actorId: Uuid;
    contentHtml?: string;
    language?: string;
    visibility?: "public" | "unlisted" | "followers" | "direct" | "none";
    quotePolicy?: "everyone" | "followers" | "self";
    quoteRequestPolicy?: "everyone" | "followers" | "self";
    reactionsCounts?: Record<string, number>;
    repliesCount?: number;
    quotesCount?: number;
    sharesCount?: number;
    published?: Date;
    updated?: Date;
    replyTargetId?: Uuid;
    quotedPostId?: Uuid;
    sharedPostId?: Uuid;
    link?: { id: Uuid; url: string };
  },
) {
  const timestamp = values.published ?? new Date("2026-04-15T00:00:00.000Z");
  const updated = values.updated ?? timestamp;
  const postId = generateUuidV7();

  const postValues: NewPost = {
    id: postId,
    iri: `https://remote.example/objects/${postId}`,
    type: "Note",
    visibility: values.visibility ?? "public",
    quotePolicy: values.quotePolicy ??
      ((values.visibility ?? "public") === "public" ||
          (values.visibility ?? "public") === "unlisted"
        ? "everyone"
        : "self"),
    quoteRequestPolicy: values.quoteRequestPolicy,
    actorId: values.actorId,
    sharedPostId: values.sharedPostId,
    replyTargetId: values.replyTargetId,
    quotedPostId: values.quotedPostId,
    linkId: values.link?.id,
    linkUrl: values.link?.url,
    contentHtml: values.contentHtml ?? "<p>Remote post</p>",
    language: values.language ?? "en",
    reactionsCounts: values.reactionsCounts ?? {},
    repliesCount: values.repliesCount,
    quotesCount: values.quotesCount,
    sharesCount: values.sharesCount,
    published: timestamp,
    updated,
  };

  await tx.insert(postTable).values(postValues);

  const post = await tx.query.postTable.findFirst({ where: { id: postId } });
  assert(post != null);
  return post;
}

export async function insertMention(
  tx: Transaction,
  values: { postId: Uuid; actorId: Uuid },
) {
  await tx.insert(mentionTable).values(values);
}

export async function insertPostLink(
  tx: Transaction,
  values: { url: string; title?: string; creatorId?: Uuid },
): Promise<PostLink> {
  const id = generateUuidV7();
  await tx.insert(postLinkTable).values({
    id,
    url: values.url,
    title: values.title,
    creatorId: values.creatorId,
  });
  const link = await tx.query.postLinkTable.findFirst({ where: { id } });
  assert(link != null);
  return link;
}

export async function insertReaction(
  tx: Transaction,
  values: { postId: Uuid; actorId: Uuid; emoji?: string; created?: Date },
) {
  await tx.insert(reactionTable).values({
    iri: `http://localhost/reactions/${generateUuidV7()}`,
    postId: values.postId,
    actorId: values.actorId,
    emoji: values.emoji ?? "❤️",
    created: values.created ?? new Date("2026-04-15T00:00:00.000Z"),
  });
}

export function createTestKv(): TestKv {
  const store = new Map<string, unknown>();

  return {
    store,
    kv: {
      get(key: string) {
        return Promise.resolve(store.get(key));
      },
      getMany(keys: string[]) {
        return Promise.resolve(keys.map((key) => store.get(key)));
      },
      set(key: string, value: unknown) {
        store.set(key, value);
        return Promise.resolve(true);
      },
      delete(key: string) {
        return Promise.resolve(store.delete(key));
      },
    } as UserContext["kv"],
  };
}

export function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function createTestDisk(): ContextData["disk"] {
  const files = new Map<string, Uint8Array>();
  return {
    getUrl(key: string) {
      return Promise.resolve(`http://localhost/media/${key}`);
    },
    getBytes(key: string) {
      const bytes = files.get(key);
      if (bytes == null) throw new Error(`No test disk file for key: ${key}`);
      return Promise.resolve(bytes);
    },
    getMetaData(key: string) {
      const bytes = files.get(key);
      if (bytes == null) throw new Error(`No test disk file for key: ${key}`);
      return Promise.resolve({
        contentLength: bytes.byteLength,
        contentType: undefined,
        etag: `"${key}"`,
        lastModified: new Date("2026-04-15T00:00:00.000Z"),
      });
    },
    put(key: string, contents: Uint8Array) {
      files.set(key, contents);
      return Promise.resolve(undefined);
    },
    delete(key: string) {
      files.delete(key);
      return Promise.resolve(undefined);
    },
  } as unknown as ContextData["disk"];
}

let mockFetchLock: Promise<void> = Promise.resolve();

export async function withMockFetch<T>(
  handler: typeof globalThis.fetch,
  run: () => Promise<T>,
): Promise<T> {
  const previousLock = mockFetchLock;
  let releaseLock!: () => void;
  mockFetchLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    releaseLock();
  }
}

export function createTestEmailTransport(): TestEmailTransport {
  const messages: unknown[] = [];

  const receipt = { successful: true, errorMessages: [] };

  return {
    messages,
    transport: {
      send(message: unknown) {
        messages.push(message);
        return Promise.resolve(receipt);
      },
      async *sendMany(batch: Iterable<unknown>) {
        for (const message of batch) {
          messages.push(message);
          yield receipt;
        }
      },
    } as unknown as Transport,
  };
}

export type FedCtxLookupObject = RequestContext<ContextData>["lookupObject"];

// Authenticated paths in production code call `getDocumentLoader` and pass
// the returned `DocumentLoader` to `lookupObject` and `persistPost`.  Tests
// almost always override `lookupObject` to return a synthetic vocab object
// directly, so the document loader itself is never invoked: the stub below
// is only there to make `getDocumentLoader` resolve without throwing.
const stubAuthenticatedDocumentLoader = () =>
  Promise.reject(
    new Error(
      "createFedCtx default authenticated DocumentLoader was invoked; " +
        "tests should override fedCtx.lookupObject so the loader stays unused.",
    ),
  );

export function createFedCtx(
  tx: Transaction,
  options: {
    kv?: UserContext["kv"];
    lookupObject?: FedCtxLookupObject;
  } = {},
): RequestContext<ContextData> {
  const kv = options.kv ?? createTestKv().kv;
  const lookupObject: FedCtxLookupObject = options.lookupObject ?? (() => {
    throw new Error(
      "createFedCtx default lookupObject was called; pass " +
        "options.lookupObject to opt in or override fedCtx.lookupObject " +
        "explicitly.",
    );
  });

  return {
    host: "localhost",
    origin: "http://localhost/",
    canonicalOrigin: "http://localhost/",
    data: {
      db: tx,
      kv: kv as unknown as ContextData["kv"],
      disk: createTestDisk(),
      models: {} as ContextData["models"],
    },
    getActorUri(identifier: string) {
      return new URL(`/actors/${identifier}`, "http://localhost/");
    },
    getInboxUri(identifier?: string) {
      return identifier == null
        ? new URL("/inbox", "http://localhost/")
        : new URL(`/actors/${identifier}/inbox`, "http://localhost/");
    },
    getOutboxUri(identifier: string) {
      return new URL(`/actors/${identifier}/outbox`, "http://localhost/");
    },
    getFollowersUri(identifier: string) {
      return new URL(`/actors/${identifier}/followers`, "http://localhost/");
    },
    getFollowingUri(identifier: string) {
      return new URL(`/actors/${identifier}/following`, "http://localhost/");
    },
    getFeaturedUri(identifier: string) {
      return new URL(`/actors/${identifier}/featured`, "http://localhost/");
    },
    getObjectUri(_type: unknown, values: Record<string, string>) {
      if ("id" in values) {
        return new URL(`/objects/${values.id}`, "http://localhost/");
      }
      return new URL(
        `/objects/${Object.values(values).join("/")}`,
        "http://localhost/",
      );
    },
    getDocumentLoader() {
      return Promise.resolve(stubAuthenticatedDocumentLoader);
    },
    lookupObject,
    sendActivity() {
      return Promise.resolve(undefined);
    },
  } as unknown as RequestContext<ContextData>;
}

function createNoopAltTextModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error(
        "altTextGenerator was called in a test that did not expect it. " +
          "Pass altTextGenerator in overrides to handle this.",
      );
    },
  });
}

export function makeUserContext(
  tx: Transaction,
  account: AuthenticatedAccount,
  overrides: Partial<UserContext> = {},
): UserContext {
  const kv = overrides.kv ?? createTestKv().kv;
  const email = overrides.email ?? createTestEmailTransport().transport;
  const fedCtx = overrides.fedCtx ?? createFedCtx(tx, { kv });

  return {
    altTextGenerator: createNoopAltTextModel(),
    db: tx,
    kv,
    disk: createTestDisk() as UserContext["disk"],
    email,
    fedCtx,
    request: new Request("http://localhost/graphql"),
    session: {
      id: generateUuidV7(),
      accountId: account.id,
      created: new Date("2026-04-15T00:00:00.000Z"),
    },
    account,
    ...overrides,
  };
}

export function makeGuestContext(
  tx: Transaction,
  overrides: Partial<UserContext> = {},
): UserContext {
  const kv = overrides.kv ?? createTestKv().kv;
  const email = overrides.email ?? createTestEmailTransport().transport;
  const fedCtx = overrides.fedCtx ?? createFedCtx(tx, { kv });

  return {
    altTextGenerator: createNoopAltTextModel(),
    db: tx,
    kv,
    disk: createTestDisk() as UserContext["disk"],
    email,
    fedCtx,
    request: new Request("http://localhost/graphql"),
    session: undefined,
    account: undefined,
    ...overrides,
  };
}
