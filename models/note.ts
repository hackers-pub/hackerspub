import type { Context } from "@fedify/fedify";
import { assertAccountActorNotSuspended } from "./moderation.ts";
import type { Recipient } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { eq, sql } from "drizzle-orm";
import type { Disk } from "flydrive";
import { syncActorFromAccount } from "./actor.ts";
import type { ContextData } from "./context.ts";
import type { Database, Transaction } from "./db.ts";
import {
  createMentionNotification,
  createQuoteNotification,
  createReplyNotification,
} from "./notification.ts";
import {
  getAllowedQuoteTargetForActor,
  syncPostFromNoteSource,
  updateRepliesCount,
} from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type Blocking,
  type Following,
  type Instance,
  type Medium,
  type Mention,
  type NewNoteSource,
  type NoteSource,
  type NoteSourceMedium,
  noteSourceMediumTable,
  noteSourceTable,
  type Post,
  type PostLink,
  type PostMedium,
  postTable,
  quoteRequestTable,
  type Reaction,
} from "./schema.ts";
import { addPostToTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
import { createMediumFromBlob } from "./medium.ts";

export type NoteSourceMediumWithMedium = NoteSourceMedium & {
  medium: Medium;
};

interface CreatePostOptions {
  afterPostCreated?: (
    post: Post,
    db: Database | Transaction,
  ) => Promise<void>;
}

export class QuotePolicyDeniedError extends Error {
  constructor() {
    super("Quote policy denied the quoted post.");
    this.name = "QuotePolicyDeniedError";
  }
}

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
    media: NoteSourceMediumWithMedium[];
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
        with: { avatarMedium: true, emails: true, links: true },
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
      media: { with: { medium: true }, orderBy: { index: "asc" } },
    },
    where: { id, accountId: account.id },
  });
}

export async function createNoteSourceMedium(
  db: Database,
  disk: Disk,
  sourceId: Uuid,
  index: number,
  input: { blob: Blob; alt: string } | { mediumId: Uuid; alt: string },
): Promise<NoteSourceMediumWithMedium | undefined> {
  const medium = "blob" in input
    ? await createMediumFromBlob(db, disk, input.blob)
    : await db.query.mediumTable.findFirst({ where: { id: input.mediumId } });
  if (medium == null) return undefined;
  const result = await db.insert(noteSourceMediumTable).values({
    sourceId,
    index,
    mediumId: medium.id,
    alt: input.alt,
  }).returning();
  return result.length > 0 ? { ...result[0], medium } : undefined;
}

export async function createNote(
  fedCtx: Context<ContextData<Transaction>>,
  source: Omit<NewNoteSource, "id"> & {
    id?: Uuid;
    media: ({ blob: Blob; alt: string } | { mediumId: Uuid; alt: string })[];
  },
  relations: {
    replyTarget?: Post & { actor: Actor };
    quotedPost?: Post & { actor: Actor };
  } = {},
  options: CreatePostOptions = {},
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      media: NoteSourceMediumWithMedium[];
    };
    media: PostMedium[];
  } | undefined
> {
  const { db, disk } = fedCtx.data;
  const account = await db.query.accountTable.findFirst({
    where: { id: source.accountId },
    with: { avatarMedium: true, emails: true, links: true },
  });
  if (account == undefined) return undefined;
  await assertAccountActorNotSuspended(db, account.id);
  if (relations.quotedPost != null) {
    const actor = await syncActorFromAccount(fedCtx, account);
    const allowedQuoteTarget = await getAllowedQuoteTargetForActor(
      db,
      actor,
      relations.quotedPost,
    );
    if (allowedQuoteTarget == null) throw new QuotePolicyDeniedError();
  }
  const noteSource = await createNoteSource(db, source);
  if (noteSource == null) return undefined;
  let index = 0;
  const media: NoteSourceMediumWithMedium[] = [];
  for (const medium of source.media) {
    const m = await createNoteSourceMedium(
      db,
      disk,
      noteSource.id,
      index,
      medium,
    );
    if (m == null) {
      await db.delete(noteSourceTable).where(
        eq(noteSourceTable.id, noteSource.id),
      );
      return undefined;
    }
    media.push(m);
    index++;
  }
  const post = await syncPostFromNoteSource(fedCtx, {
    ...noteSource,
    media,
    account,
  }, relations);
  if (post == null) {
    await db.delete(noteSourceTable).where(
      eq(noteSourceTable.id, noteSource.id),
    );
    if (relations.quotedPost != null) throw new QuotePolicyDeniedError();
    throw new Error("Failed to persist note post.");
  }
  if (relations.replyTarget != null) {
    await updateRepliesCount(db, relations.replyTarget, 1);
  }
  await addPostToTimeline(db, post);
  await options.afterPostCreated?.(post, db);
  const noteObject = await fedCtx.data.services.federation.getNote(
    fedCtx,
    { ...noteSource, media, account },
    {
      replyTargetId: relations.replyTarget == null
        ? undefined
        : new URL(relations.replyTarget.iri),
      quotedPost: post.quoteRequestRequired
        ? undefined
        : post.quotedPost ?? undefined,
      quoteAuthorizationIri: post.quoteAuthorizationIri,
      quoteRequestPolicy: post.quoteRequestPolicy,
    },
  );
  const activity = new vocab.Create({
    id: new URL("#create", noteObject.id ?? fedCtx.origin),
    actor: fedCtx.getActorUri(source.accountId),
    tos: noteObject.toIds,
    ccs: noteObject.ccIds,
    object: noteObject,
  });
  const orderingKey = post.iri;
  const quoteRequestTarget = post.quoteRequestTarget;
  if (post.quoteRequestRequired && quoteRequestTarget != null) {
    const requestId = new URL("#quote-request", noteObject.id ?? fedCtx.origin);
    const instrument = await fedCtx.data.services.federation.getNote(
      fedCtx,
      { ...noteSource, media, account },
      {
        replyTargetId: relations.replyTarget == null
          ? undefined
          : new URL(relations.replyTarget.iri),
        quotedPost: quoteRequestTarget,
        quoteRequestPolicy: post.quoteRequestPolicy,
      },
    );
    const request = new vocab.QuoteRequest({
      id: requestId,
      actor: fedCtx.getActorUri(source.accountId),
      object: new URL(quoteRequestTarget.iri),
      instrument,
    });
    await db.insert(quoteRequestTable).values({
      id: generateUuidV7(),
      iri: requestId.href,
      quotePostId: post.id,
      quotedPostId: quoteRequestTarget.id,
    }).onConflictDoUpdate({
      target: quoteRequestTable.iri,
      set: {
        quotePostId: post.id,
        quotedPostId: quoteRequestTarget.id,
        accepted: null,
        rejected: null,
        updated: sql`CURRENT_TIMESTAMP`,
      },
    });
    await fedCtx.sendActivity(
      { identifier: source.accountId },
      {
        id: new URL(quoteRequestTarget.actor.iri),
        inboxId: new URL(quoteRequestTarget.actor.inboxUrl),
        endpoints: quoteRequestTarget.actor.sharedInboxUrl == null
          ? null
          : { sharedInbox: new URL(quoteRequestTarget.actor.sharedInboxUrl) },
      },
      request,
      {
        orderingKey,
        preferSharedInbox: true,
      },
    );
  }
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
      {
        orderingKey,
        preferSharedInbox: false,
        excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
      },
    );
  }
  if (post.visibility !== "direct") {
    await fedCtx.sendActivity(
      { identifier: source.accountId },
      "followers",
      activity,
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
      },
    );
  }
  const relayedTags = await fedCtx.data.services.federation
    .sendTagsPubRelayActivity(
      fedCtx,
      source.accountId,
      activity,
      {
        orderingKey,
        visibility: post.visibility,
        accountBio: account.bio,
      },
    );
  if (relayedTags != null) {
    await db.update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, post.id));
    post.relayedTags = [...relayedTags];
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
      media: NoteSourceMediumWithMedium[];
    };
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
  } | undefined
> {
  const { db } = fedCtx.data;
  const previousPost = await db.query.postTable.findFirst({
    where: { noteSourceId },
  });
  if (previousPost != null && previousPost.type !== "Note") return undefined;
  // Capture previous mention recipients before the update so that removed
  // mentions still receive the Update activity and can retire their copy.
  const previousMentions = previousPost == null ? [] : (
    await db.query.mentionTable.findMany({
      where: { postId: previousPost.id },
      with: { actor: true },
    })
  );
  const noteSource = await updateNoteSource(db, noteSourceId, source);
  if (noteSource == null) return undefined;
  const account = await db.query.accountTable.findFirst({
    where: { id: noteSource.accountId },
    with: { avatarMedium: true, emails: true, links: true },
  });
  const media = await db.query.noteSourceMediumTable.findMany({
    where: { sourceId: noteSourceId },
    with: { medium: true },
    orderBy: { index: "asc" },
  });
  if (account == null) return undefined;
  const post = await syncPostFromNoteSource(fedCtx, {
    ...noteSource,
    account,
    media,
  });
  if (post == null) return undefined;
  // A censored post must not federate its (moderation-hidden) content: the
  // local edit persists so the author can keep working on their hidden post,
  // but no Update(Note) is delivered to mentions, followers, or tag relays
  // while it remains censored.
  if (post.censored != null) return post;
  const noteObject = await fedCtx.data.services.federation.getNote(
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
      quoteAuthorizationIri: post.quoteAuthorizationIri,
      quoteRequestPolicy: post.quoteRequestPolicy,
    },
  );
  const activity = new vocab.Update({
    id: new URL(
      `#update/${noteSource.updated.toISOString()}`,
      noteObject.id ?? fedCtx.canonicalOrigin,
    ),
    actor: fedCtx.getActorUri(noteSource.accountId),
    tos: noteObject.toIds,
    ccs: noteObject.ccIds,
    object: noteObject,
  });
  // Deliver to the union of current and previous mention recipients so that
  // actors whose mentions were removed still receive the Update activity.
  const allMentionActors = new Map(
    [...previousMentions, ...post.mentions].map((m) => [m.actor.iri, m.actor]),
  );
  if (post.visibility !== "none" && allMentionActors.size > 0) {
    const directRecipients: Recipient[] = [...allMentionActors.values()].map(
      (actor) => ({
        id: new URL(actor.iri),
        inboxId: new URL(actor.inboxUrl),
        endpoints: actor.sharedInboxUrl == null
          ? null
          : { sharedInbox: new URL(actor.sharedInboxUrl) },
      }),
    );
    await fedCtx.sendActivity(
      { identifier: noteSource.accountId },
      directRecipients,
      activity,
      {
        orderingKey: post.iri,
        preferSharedInbox: false,
        excludeBaseUris: [
          new URL(fedCtx.origin),
          new URL(fedCtx.canonicalOrigin),
        ],
      },
    );
  }
  if (post.visibility !== "direct" && post.visibility !== "none") {
    await fedCtx.sendActivity(
      { identifier: noteSource.accountId },
      "followers",
      activity,
      {
        orderingKey: post.iri,
        preferSharedInbox: true,
        excludeBaseUris: [
          new URL(fedCtx.origin),
          new URL(fedCtx.canonicalOrigin),
        ],
      },
    );
  }
  const relayedTags = await fedCtx.data.services.federation
    .sendTagsPubRelayActivity(
      fedCtx,
      noteSource.accountId,
      activity,
      {
        orderingKey: post.iri,
        visibility: post.visibility,
        accountBio: account.bio,
        relayedTags: previousPost?.relayedTags,
      },
    );
  if (relayedTags != null) {
    await db.update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, post.id));
    post.relayedTags = [...relayedTags];
  }
  return post;
}
