import { assert } from "@std/assert/assert";
import type { RequestContext } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import type { Transport } from "@upyo/core";
import {
  accountEmailTable,
  accountTable,
  actorTable,
  instanceTable,
  mentionTable,
  type NewPost,
  noteSourceTable,
  postTable,
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

export async function insertAccountWithActor(
  tx: Transaction,
  values: {
    username: string;
    name: string;
    email: string;
    iri?: string;
    inboxUrl?: string;
    host?: string;
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
    type: "Person",
    username: values.username,
    instanceHost: host,
    handleHost: host,
    accountId,
    name: values.name,
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
  },
) {
  const actorId = generateUuidV7();
  const timestamp = new Date("2026-04-15T00:00:00.000Z");

  await seedLocalInstance(tx, values.host);

  await tx.insert(actorTable).values({
    id: actorId,
    iri: values.iri ?? `https://${values.host}/users/${values.username}`,
    type: "Person",
    username: values.username,
    instanceHost: values.host,
    handleHost: values.host,
    name: values.name,
    inboxUrl: values.inboxUrl ??
      `https://${values.host}/users/${values.username}/inbox`,
    sharedInboxUrl: `https://${values.host}/inbox`,
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
    reactionsCounts?: Record<string, number>;
    replyTargetId?: Uuid;
    quotedPostId?: Uuid;
    sharedPostId?: Uuid;
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
    actorId: (values.actorId ?? values.account.actor.id) as Uuid,
    noteSourceId,
    sharedPostId: values.sharedPostId,
    replyTargetId: values.replyTargetId,
    quotedPostId: values.quotedPostId,
    contentHtml: values.contentHtml ??
      `<p>${values.content ?? "Hello world"}</p>`,
    language: values.language ?? "en",
    reactionsCounts: values.reactionsCounts ?? {},
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
    published?: Date;
    updated?: Date;
    replyTargetId?: Uuid;
    quotedPostId?: Uuid;
    sharedPostId?: Uuid;
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
    actorId: values.actorId,
    sharedPostId: values.sharedPostId,
    replyTargetId: values.replyTargetId,
    quotedPostId: values.quotedPostId,
    contentHtml: values.contentHtml ?? "<p>Remote post</p>",
    language: values.language ?? "en",
    reactionsCounts: {},
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
  return {
    getUrl(key: string) {
      return Promise.resolve(`http://localhost/media/${key}`);
    },
    put() {
      return Promise.resolve(undefined);
    },
    delete() {
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

export function createFedCtx(
  tx: Transaction,
  options: { kv?: UserContext["kv"] } = {},
): RequestContext<ContextData> {
  const kv = options.kv ?? createTestKv().kv;

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
    getFollowersUri(identifier: string) {
      return new URL(`/actors/${identifier}/followers`, "http://localhost/");
    },
    getFollowingUri(identifier: string) {
      return new URL(`/actors/${identifier}/following`, "http://localhost/");
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
    sendActivity() {
      return Promise.resolve(undefined);
    },
  } as unknown as RequestContext<ContextData>;
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
