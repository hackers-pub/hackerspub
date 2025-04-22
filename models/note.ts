import type { Context, Recipient } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import type { ContextData } from "@hackerspub/federation/builder";
import { eq, sql } from "drizzle-orm";
import type { Disk } from "flydrive";
import type Keyv from "keyv";
import sharp from "sharp";
import { getNote } from "../federation/objects.ts";
import type { Database } from "./db.ts";
import {
  createMentionNotification,
  createQuoteNotification,
  createReplyNotification,
} from "./notification.ts";
import { syncPostFromNoteSource, updateRepliesCount } from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type Blocking,
  type Following,
  type Instance,
  type Mention,
  type NewNoteSource,
  type NoteMedium,
  noteMediumTable,
  type NoteSource,
  noteSourceTable,
  type Post,
  type PostLink,
  type PostMedium,
  type Reaction,
} from "./schema.ts";
import { addPostToTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

export async function createNoteSource(
  db: Database,
  source: Omit<NewNoteSource, "id"> & { id?: Uuid },
): Promise<NoteSource | undefined> {
  const rows = await db.insert(noteSourceTable)
    .values({ id: generateUuidV7(), ...source })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}

export async function getNoteSource(
  db: Database,
  username: string,
  id: Uuid,
  signedAccount: Account & { actor: Actor } | undefined,
): Promise<
  NoteSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    post: Post & {
      actor: Actor & {
        instance: Instance;
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
      link: PostLink & { creator?: Actor | null } | null;
      sharedPost:
        | Post & {
          actor: Actor & {
            instance: Instance;
            followers: Following[];
            blockees: Blocking[];
            blockers: Blocking[];
          };
          link: PostLink & { creator?: Actor | null } | null;
          replyTarget:
            | Post & {
              actor: Actor & {
                instance: Instance;
                followers: Following[];
                blockees: Blocking[];
                blockers: Blocking[];
              };
              link: PostLink & { creator?: Actor | null } | null;
              mentions: (Mention & { actor: Actor })[];
              media: PostMedium[];
            }
            | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
          shares: Post[];
          reactions: Reaction[];
        }
        | null;
      replyTarget:
        | Post & {
          actor: Actor & {
            instance: Instance;
            followers: Following[];
            blockees: Blocking[];
            blockers: Blocking[];
          };
          link: PostLink & { creator?: Actor | null } | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
        }
        | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
      reactions: Reaction[];
    };
    media: NoteMedium[];
  } | undefined
> {
  let account = await db.query.accountTable.findFirst({
    where: { username },
  });
  if (account == null) {
    account = await db.query.accountTable.findFirst({
      where: {
        oldUsername: username,
        usernameChanged: { isNotNull: true },
      },
      orderBy: { usernameChanged: "desc" },
    });
  }
  if (account == null) return undefined;
  return await db.query.noteSourceTable.findFirst({
    with: {
      account: {
        with: { emails: true, links: true },
      },
      post: {
        with: {
          actor: {
            with: {
              instance: true,
              followers: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { followerId: signedAccount.actor.id },
              },
              blockees: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { blockeeId: signedAccount.actor.id },
              },
              blockers: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { blockerId: signedAccount.actor.id },
              },
            },
          },
          link: { with: { creator: true } },
          mentions: {
            with: { actor: true },
          },
          sharedPost: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { followerId: signedAccount.actor.id },
                  },
                  blockees: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockeeId: signedAccount.actor.id },
                  },
                  blockers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockerId: signedAccount.actor.id },
                  },
                },
              },
              link: { with: { creator: true } },
              replyTarget: {
                with: {
                  actor: {
                    with: {
                      instance: true,
                      followers: {
                        where: signedAccount == null ? { RAW: sql`false` } : {
                          followerId: signedAccount.actor.id,
                        },
                      },
                      blockees: {
                        where: signedAccount == null
                          ? { RAW: sql`false` }
                          : { blockeeId: signedAccount.actor.id },
                      },
                      blockers: {
                        where: signedAccount == null
                          ? { RAW: sql`false` }
                          : { blockerId: signedAccount.actor.id },
                      },
                    },
                  },
                  link: { with: { creator: true } },
                  mentions: {
                    with: { actor: true },
                  },
                  media: true,
                },
              },
              mentions: {
                with: { actor: true },
              },
              media: true,
              shares: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { actorId: signedAccount.actor.id },
              },
              reactions: {
                where: signedAccount == null
                  ? { RAW: sql`false` }
                  : { actorId: signedAccount.actor.id },
              },
            },
          },
          replyTarget: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { followerId: signedAccount.actor.id },
                  },
                  blockees: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockeeId: signedAccount.actor.id },
                  },
                  blockers: {
                    where: signedAccount == null
                      ? { RAW: sql`false` }
                      : { blockerId: signedAccount.actor.id },
                  },
                },
              },
              link: { with: { creator: true } },
              mentions: {
                with: { actor: true },
              },
              media: true,
            },
          },
          media: true,
          shares: {
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
          reactions: {
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
        },
      },
      media: true,
    },
    where: { id, accountId: account.id },
  });
}

export async function createNoteMedium(
  db: Database,
  disk: Disk,
  sourceId: Uuid,
  index: number,
  medium: { blob: Blob; alt: string },
): Promise<NoteMedium | undefined> {
  const image = sharp(await medium.blob.arrayBuffer()).rotate();
  const { width, height } = await image.metadata();
  if (width == null || height == null) return undefined;
  const buffer = await image.webp().toBuffer();
  const key = `note-media/${crypto.randomUUID()}.webp`;
  await disk.put(key, new Uint8Array(buffer));
  const result = await db.insert(noteMediumTable).values({
    sourceId,
    index,
    key,
    alt: medium.alt,
    width,
    height,
  }).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function createNote(
  db: Database,
  kv: Keyv,
  disk: Disk,
  fedCtx: Context<ContextData>,
  source: Omit<NewNoteSource, "id"> & {
    id?: Uuid;
    media: { blob: Blob; alt: string }[];
  },
  relations: {
    replyTarget?: Post & { actor: Actor };
    quotedPost?: Post & { actor: Actor };
  } = {},
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      media: NoteMedium[];
    };
    media: PostMedium[];
  } | undefined
> {
  const noteSource = await createNoteSource(db, source);
  if (noteSource == null) return undefined;
  let index = 0;
  const media = [];
  for (const medium of source.media) {
    const m = await createNoteMedium(db, disk, noteSource.id, index, medium);
    if (m != null) media.push(m);
    index++;
  }
  const account = await db.query.accountTable.findFirst({
    where: { id: source.accountId },
    with: { emails: true, links: true },
  });
  if (account == undefined) return undefined;
  const post = await syncPostFromNoteSource(db, kv, disk, fedCtx, {
    ...noteSource,
    media,
    account,
  }, relations);
  if (relations.replyTarget != null) {
    await updateRepliesCount(db, relations.replyTarget, 1);
  }
  await addPostToTimeline(db, post);
  const noteObject = await getNote(
    db,
    disk,
    fedCtx,
    { ...noteSource, media, account },
    {
      replyTargetId: relations.replyTarget == null
        ? undefined
        : new URL(relations.replyTarget.iri),
      quotedPost: relations.quotedPost ?? undefined,
    },
  );
  const activity = new vocab.Create({
    id: new URL("#create", noteObject.id ?? fedCtx.origin),
    actors: noteObject.attributionIds,
    tos: noteObject.toIds,
    ccs: noteObject.ccIds,
    object: noteObject,
  });
  if (post.mentions.length > 0) {
    const directRecipients: Recipient[] = post.mentions.map((m) => ({
      id: new URL(m.actor.iri),
      inboxId: new URL(m.actor.inboxUrl),
      endpoints: m.actor.sharedInboxUrl == null
        ? null
        : { sharedInbox: new URL(m.actor.sharedInboxUrl) },
    }));
    await fedCtx.sendActivity(
      { identifier: source.accountId },
      directRecipients,
      activity,
      { preferSharedInbox: false, excludeBaseUris: [new URL(fedCtx.origin)] },
    );
  }
  if (post.visibility !== "direct") {
    await fedCtx.sendActivity(
      { identifier: source.accountId },
      "followers",
      activity,
      { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
    );
  }
  if (
    post.replyTarget != null && post.replyTarget.actor.accountId != null &&
    post.replyTarget.actorId !== post.actorId
  ) {
    await createReplyNotification(
      db,
      post.replyTarget.actor.accountId,
      post,
      post.actor,
    );
  }
  if (
    post.quotedPost != null && post.quotedPost.actor.accountId != null &&
    post.quotedPost.actorId !== post.actorId
  ) {
    await createQuoteNotification(
      db,
      post.quotedPost.actor.accountId,
      post,
      post.actor,
    );
  }
  for (const mention of post.mentions) {
    if (mention.actor.accountId == null) continue;
    if (post.replyTarget?.actorId === mention.actorId) continue;
    if (post.quotedPost?.actorId === mention.actorId) continue;
    if (mention.actorId === post.actorId) continue;
    await createMentionNotification(
      db,
      mention.actor.accountId,
      post,
      post.actor,
    );
  }
  return post;
}

export async function updateNoteSource(
  db: Database,
  noteSourceId: Uuid,
  source: Partial<NewNoteSource>,
): Promise<NoteSource | undefined> {
  const rows = await db.update(noteSourceTable)
    .set({ ...source, updated: sql`CURRENT_TIMESTAMP` })
    .where(eq(noteSourceTable.id, noteSourceId))
    .returning();
  return rows[0];
}

export async function updateNote(
  db: Database,
  kv: Keyv,
  disk: Disk,
  fedCtx: Context<ContextData>,
  noteSourceId: Uuid,
  source: Partial<NewNoteSource>,
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      media: NoteMedium[];
    };
    mentions: Mention[];
    media: PostMedium[];
  } | undefined
> {
  const noteSource = await updateNoteSource(db, noteSourceId, source);
  if (noteSource == null) return undefined;
  const account = await db.query.accountTable.findFirst({
    where: { id: noteSource.accountId },
    with: { emails: true, links: true },
  });
  const media = await db.query.noteMediumTable.findMany({
    where: { sourceId: noteSourceId },
  });
  if (account == null) return undefined;
  const post = await syncPostFromNoteSource(db, kv, disk, fedCtx, {
    ...noteSource,
    account,
    media,
  });
  const noteObject = await getNote(
    db,
    disk,
    fedCtx,
    { ...noteSource, media, account },
    {
      replyTargetId: post.replyTargetId == null
        ? undefined
        : await db.query.postTable.findFirst({
          where: { id: post.replyTargetId },
        }).then((r) => r?.iri == null ? undefined : new URL(r.iri)),
      quotedPost: post.quotedPostId == null
        ? undefined
        : await db.query.postTable.findFirst({
          where: { id: post.quotedPostId },
        }),
    },
  );
  await fedCtx.sendActivity(
    { identifier: noteSource.accountId },
    "followers",
    new vocab.Update({
      id: new URL(
        `#update/${noteSource.updated.toISOString()}`,
        noteObject.id ?? fedCtx.canonicalOrigin,
      ),
      actors: noteObject.attributionIds,
      tos: noteObject.toIds,
      ccs: noteObject.ccIds,
      object: noteObject,
    }),
    {
      preferSharedInbox: true,
      excludeBaseUris: [
        new URL(fedCtx.origin),
        new URL(fedCtx.canonicalOrigin),
      ],
    },
  );
  return post;
}
