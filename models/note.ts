import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Disk } from "flydrive";
import type Keyv from "keyv";
import sharp from "sharp";
import type { Database } from "../db.ts";
import { getNote } from "../federation/objects.ts";
import { syncPostFromNoteSource, updateRepliesCount } from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  accountTable,
  type Actor,
  type Following,
  type Instance,
  type Mention,
  type NewNoteSource,
  type NoteMedium,
  noteMediumTable,
  type NoteSource,
  noteSourceTable,
  type Post,
  type PostMedium,
  postTable,
} from "./schema.ts";
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

export function getNoteSource(
  db: Database,
  username: string,
  id: Uuid,
  signedAccount?: Account & { actor: Actor },
): Promise<
  NoteSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    post: Post & {
      actor: Actor & { followers: Following[] };
      sharedPost:
        | Post & {
          actor: Actor;
          replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
          media: PostMedium[];
          shares: Post[];
        }
        | null;
      replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
      mentions: Mention[];
      media: PostMedium[];
      shares: Post[];
    };
    media: NoteMedium[];
  } | undefined
> {
  return db.query.noteSourceTable.findFirst({
    with: {
      account: {
        with: { emails: true, links: true },
      },
      post: {
        with: {
          actor: {
            with: { followers: true },
          },
          mentions: true,
          sharedPost: {
            with: {
              actor: true,
              replyTarget: {
                with: { actor: true, media: true },
              },
              media: true,
              shares: {
                where: signedAccount == null
                  ? sql`false`
                  : eq(postTable.actorId, signedAccount.actor.id),
              },
            },
          },
          replyTarget: {
            with: { actor: true, media: true },
          },
          media: true,
          shares: {
            where: signedAccount == null
              ? sql`false`
              : eq(postTable.actorId, signedAccount.actor.id),
          },
        },
      },
      media: true,
    },
    where: and(
      eq(noteSourceTable.id, id),
      inArray(
        noteSourceTable.accountId,
        db.select({ id: accountTable.id })
          .from(accountTable)
          .where(eq(accountTable.username, username)),
      ),
    ),
  });
}

export async function createNoteMedium(
  db: Database,
  disk: Disk,
  sourceId: Uuid,
  index: number,
  medium: { blob: Blob; alt: string },
): Promise<NoteMedium | undefined> {
  const image = sharp(await medium.blob.arrayBuffer());
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
  fedCtx: Context<void>,
  source: Omit<NewNoteSource, "id"> & {
    id?: Uuid;
    media: { blob: Blob; alt: string }[];
  },
  replyTarget?: Post,
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
    where: eq(accountTable.id, source.accountId),
    with: { emails: true, links: true },
  });
  if (account == undefined) return undefined;
  const post = await syncPostFromNoteSource(db, kv, disk, fedCtx, {
    ...noteSource,
    media,
    account,
  }, replyTarget);
  if (replyTarget != null) await updateRepliesCount(db, replyTarget.id);
  const noteObject = await getNote(
    db,
    disk,
    fedCtx,
    { ...noteSource, media, account },
    replyTarget == null ? undefined : new URL(replyTarget.iri),
  );
  await fedCtx.sendActivity(
    { identifier: source.accountId },
    "followers",
    new vocab.Create({
      id: new URL("#create", noteObject.id ?? fedCtx.origin),
      actors: noteObject.attributionIds,
      tos: noteObject.toIds,
      ccs: noteObject.ccIds,
      object: noteObject,
    }),
    { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  return post;
}
