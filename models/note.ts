import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { and, eq, inArray } from "drizzle-orm";
import Keyv from "keyv";
import type { Database } from "../db.ts";
import { syncPostFromNoteSource, updateRepliesCount } from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  accountTable,
  type Actor,
  type Following,
  type Instance,
  type Medium,
  type Mention,
  type NewNoteSource,
  type NoteSource,
  noteSourceTable,
  type Post,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
import { getNote } from "../federation/objects.ts";

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
): Promise<
  NoteSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    post: Post & {
      actor: Actor & { followers: Following[] };
      sharedPost:
        | Post & {
          actor: Actor;
          replyTarget: Post & { actor: Actor; media: Medium[] } | null;
          media: Medium[];
        }
        | null;
      replyTarget: Post & { actor: Actor; media: Medium[] } | null;
      mentions: Mention[];
      media: Medium[];
    };
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
            },
          },
          replyTarget: {
            with: { actor: true, media: true },
          },
          media: true,
        },
      },
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

export async function createNote(
  db: Database,
  kv: Keyv,
  fedCtx: Context<void>,
  source: Omit<NewNoteSource, "id"> & { id?: Uuid },
  replyTarget?: Post,
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    };
  } | undefined
> {
  const noteSource = await createNoteSource(db, source);
  if (noteSource == null) return undefined;
  const account = await db.query.accountTable.findFirst({
    where: eq(accountTable.id, source.accountId),
    with: { emails: true, links: true },
  });
  if (account == undefined) return undefined;
  const post = await syncPostFromNoteSource(db, kv, fedCtx, {
    ...noteSource,
    account,
  }, replyTarget);
  if (replyTarget != null) await updateRepliesCount(db, replyTarget.id);
  const noteObject = await getNote(
    db,
    fedCtx,
    { ...noteSource, account },
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
