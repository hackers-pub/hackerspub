import type { Context, DocumentLoader } from "@fedify/fedify";
import { assertAccountActorNotSuspended } from "./moderation.ts";
import { isActor } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { getEmojiReact, getEmojiReactId } from "@hackerspub/federation/objects";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getPersistedActor, persistActor } from "./actor.ts";
import type { ContextData } from "./context.ts";
import type { Database } from "./db.ts";
import { DEFAULT_REACTION_EMOJI, type ReactionEmoji } from "./emoji.ts";
import { refreshNewsScores } from "./news.ts";
import {
  createReactNotification,
  deleteReactNotification,
} from "./notification.ts";
import { getPersistedPost, isPostObject, persistPost } from "./post.ts";
import {
  type Account,
  type Actor,
  type CustomEmoji,
  customEmojiTable,
  type Post,
  postTable,
  type Reaction,
  reactionTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

function isCustomEmojiShortcode(value: string): boolean {
  return /^:[^:\s]+:$/.test(value);
}

export async function persistCustomEmoji(
  db: Database,
  emoji: vocab.Emoji,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
): Promise<CustomEmoji | undefined> {
  if (emoji.id == null || emoji.name == null) return undefined;
  const icon = await emoji.getIcon({
    ...options,
    suppressError: true,
  });
  if (icon == null) return undefined;
  const href = icon.url instanceof vocab.Link ? icon.url.href : icon.url;
  if (href == null) return undefined;
  const name = `:${emoji.name.toString().replaceAll(/^:|:$/g, "")}:`;
  const rows = await db.insert(customEmojiTable).values({
    id: generateUuidV7(),
    iri: emoji.id.href,
    name,
    imageType: icon.mediaType,
    imageUrl: href.href,
  }).onConflictDoUpdate({
    target: customEmojiTable.iri,
    set: {
      name,
      imageType: icon.mediaType,
      imageUrl: href.href,
    },
    setWhere: eq(customEmojiTable.iri, emoji.id.href),
  }).returning();
  if (rows.length < 1) return undefined;
  return rows[0];
}

export async function persistReaction(
  ctx: Context<ContextData>,
  reaction: vocab.Like | vocab.EmojiReact,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
): Promise<Reaction | undefined> {
  if (
    reaction.id == null || reaction.actorId == null || reaction.objectId == null
  ) {
    return undefined;
  }
  const { db } = ctx.data;
  let actor = await getPersistedActor(db, reaction.actorId);
  const opts = { ...options, suppressError: true };
  if (actor == null) {
    const actorObject = await reaction.getActor(opts);
    if (!isActor(actorObject)) return undefined;
    actor = await persistActor(ctx, actorObject, options);
  }
  if (actor == null) return undefined;
  let post = await getPersistedPost(db, reaction.objectId);
  if (post == null) {
    const object = await reaction.getObject(opts);
    if (!isPostObject(object)) return undefined;
    post = await persistPost(ctx, object, options);
  }
  if (post == null) return undefined;
  const customEmojis: Record<string, CustomEmoji> = {};
  for await (const tag of reaction.getTags(opts)) {
    if (tag instanceof vocab.Emoji) {
      const customEmoji = await persistCustomEmoji(db, tag, options);
      if (customEmoji == null) continue;
      customEmojis[customEmoji.name] = customEmoji;
    }
  }
  const emoji = reaction.content?.toString()?.trim() ?? DEFAULT_REACTION_EMOJI;
  const customEmoji = customEmojis[emoji];
  if (customEmoji == null && isCustomEmojiShortcode(emoji)) return undefined;
  const rows = await db.insert(reactionTable)
    .values({
      iri: reaction.id.href,
      postId: post.id,
      actorId: actor.id,
      emoji: customEmoji == null ? emoji : null,
      customEmojiId: customEmoji?.id ?? null,
      created: reaction.published == null
        ? sql`CURRENT_TIMESTAMP`
        : new Date(reaction.published.epochMilliseconds),
    })
    .onConflictDoNothing()
    .returning();
  if (rows.length < 1) return undefined;
  if (post.actor.accountId != null && post.actorId !== actor.id) {
    await createReactNotification(
      db,
      post.actor.accountId,
      post,
      actor,
      customEmoji ?? emoji,
    );
  }
  return rows[0];
}

export async function deleteReaction(
  db: Database,
  reaction: vocab.Like | vocab.EmojiReact,
  options: {
    contextLoader?: DocumentLoader;
    documentLoader?: DocumentLoader;
  },
): Promise<Reaction | undefined> {
  if (reaction.id == null) return undefined;
  const rows = await db.delete(reactionTable)
    .where(eq(reactionTable.iri, reaction.id.href))
    .returning();
  if (rows.length > 0) {
    const post = await db.query.postTable.findFirst({
      where: { id: rows[0].postId },
      with: { actor: true },
    });
    const actor = await db.query.actorTable.findFirst({
      where: { id: rows[0].actorId },
    });
    if (
      post?.actor.accountId != null && actor != null &&
      post.actorId !== actor.id
    ) {
      await deleteReactNotification(
        db,
        post.actor.accountId,
        post,
        actor,
        rows[0].emoji ?? (await db.query.customEmojiTable.findFirst({
          where: { id: rows[0].customEmojiId! },
        }))!,
      );
    }
    return rows[0];
  }
  if (reaction.actorId == null || reaction.objectId == null) return undefined;
  const actor = await getPersistedActor(db, reaction.actorId);
  if (actor == null) return undefined;
  const post = await getPersistedPost(db, reaction.objectId);
  if (post == null) return undefined;
  const opts = { ...options, suppressError: true };
  const customEmojis: Record<string, CustomEmoji> = {};
  for await (const tag of reaction.getTags(opts)) {
    if (tag instanceof vocab.Emoji) {
      const customEmoji = await persistCustomEmoji(db, tag, options);
      if (customEmoji == null) continue;
      customEmojis[customEmoji.name] = customEmoji;
    }
  }
  const emoji = reaction.content?.toString()?.trim() ?? DEFAULT_REACTION_EMOJI;
  const deleted = await db.delete(reactionTable)
    .where(
      and(
        eq(reactionTable.postId, post.id),
        eq(reactionTable.actorId, actor.id),
        emoji in customEmojis
          ? eq(reactionTable.customEmojiId, customEmojis[emoji].id)
          : eq(reactionTable.emoji, emoji),
      ),
    )
    .returning();
  if (deleted.length < 1) return undefined;
  if (post?.actor.accountId != null && post.actorId !== actor.id) {
    await deleteReactNotification(
      db,
      post.actor.accountId,
      post,
      actor,
      emoji in customEmojis ? customEmojis[emoji] : emoji,
    );
  }
  return deleted[0];
}

export async function react(
  ctx: Context<ContextData>,
  account: Account & { actor: Actor },
  post: Post & { actor: Actor },
  emoji: ReactionEmoji | null,
  customEmojiId?: Uuid,
): Promise<Reaction | undefined> {
  const { db } = ctx.data;
  await assertAccountActorNotSuspended(db, account.id);
  let iri: string;
  if (emoji != null) {
    iri = getEmojiReactId(ctx, account.id, post.id, emoji).href;
  } else {
    iri = new URL(
      `/ap/emojireacts/custom/${generateUuidV7()}`,
      ctx.canonicalOrigin,
    ).href;
  }
  const rows = await db.insert(reactionTable)
    .values({
      iri,
      postId: post.id,
      actorId: account.actor.id,
      emoji,
      customEmojiId: customEmojiId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (rows.length < 1) return undefined;
  await updateReactionsCounts(db, post.id);
  if (post.actor.accountId != null && post.actorId !== account.actor.id) {
    let notifEmoji: string | CustomEmoji = emoji ?? DEFAULT_REACTION_EMOJI;
    if (emoji == null && customEmojiId != null) {
      const customEmoji = await db.query.customEmojiTable.findFirst({
        where: { id: customEmojiId },
      });
      if (customEmoji != null) notifEmoji = customEmoji;
    }
    await createReactNotification(
      db,
      post.actor.accountId,
      post,
      account.actor,
      notifEmoji,
    );
  }
  if (emoji == null) return rows[0];
  const activity = getEmojiReact(ctx, {
    ...rows[0],
    actor: account.actor,
    post,
  });
  if (activity == null) return rows[0];
  const orderingKey = iri;
  await ctx.sendActivity(
    { identifier: account.id },
    {
      id: new URL(post.actor.iri),
      inboxId: new URL(post.actor.inboxUrl),
      endpoints: post.actor.sharedInboxUrl == null
        ? null
        : { sharedInbox: new URL(post.actor.sharedInboxUrl) },
    },
    activity,
    {
      orderingKey,
      excludeBaseUris: [new URL(ctx.canonicalOrigin)],
      fanout: "skip",
    },
  );
  await ctx.sendActivity(
    { identifier: account.id },
    "followers",
    activity,
    {
      orderingKey,
      excludeBaseUris: [new URL(ctx.canonicalOrigin)],
      preferSharedInbox: true,
    },
  );
  return rows[0];
}

export async function undoReaction(
  ctx: Context<ContextData>,
  account: Account & { actor: Actor },
  post: Post & { actor: Actor },
  emoji: ReactionEmoji | null,
  customEmojiId?: Uuid,
): Promise<Reaction | undefined> {
  const { db } = ctx.data;
  const whereClause = emoji != null
    ? and(
      eq(reactionTable.postId, post.id),
      eq(reactionTable.actorId, account.actor.id),
      eq(reactionTable.emoji, emoji),
    )
    : and(
      eq(reactionTable.postId, post.id),
      eq(reactionTable.actorId, account.actor.id),
      eq(reactionTable.customEmojiId, customEmojiId!),
    );
  const rows = await db.delete(reactionTable)
    .where(whereClause)
    .returning();
  if (rows.length < 1) return undefined;
  await updateReactionsCounts(db, post.id);
  // If the reacted post shares a link, its reaction total just dropped; the
  // periodic sweep can't see a removed reaction, so re-score the link here.
  await refreshNewsScores(db, [post.linkId]);
  if (post.actor.accountId != null && post.actorId !== account.actor.id) {
    let notifEmoji: string | CustomEmoji = emoji ?? DEFAULT_REACTION_EMOJI;
    if (emoji == null && customEmojiId != null) {
      const customEmoji = await db.query.customEmojiTable.findFirst({
        where: { id: customEmojiId },
      });
      if (customEmoji != null) notifEmoji = customEmoji;
    }
    await deleteReactNotification(
      db,
      post.actor.accountId,
      post,
      account.actor,
      notifEmoji,
    );
  }
  if (emoji == null) return rows[0];
  const activity = getEmojiReact(ctx, {
    ...rows[0],
    actor: account.actor,
    post,
  });
  if (activity?.id == null) return rows[0];
  const orderingKey = activity.id.href;
  const undo = new vocab.Undo({
    id: new URL("#undo", activity.id),
    actor: ctx.getActorUri(account.id),
    tos: activity.toIds,
    ccs: activity.ccIds,
    object: activity,
    content: emoji,
  });
  await ctx.sendActivity(
    { identifier: account.id },
    {
      id: new URL(post.actor.iri),
      inboxId: new URL(post.actor.inboxUrl),
      endpoints: post.actor.sharedInboxUrl == null
        ? null
        : { sharedInbox: new URL(post.actor.sharedInboxUrl) },
    },
    undo,
    {
      orderingKey,
      excludeBaseUris: [new URL(ctx.canonicalOrigin)],
      fanout: "skip",
    },
  );
  await ctx.sendActivity(
    { identifier: account.id },
    "followers",
    undo,
    {
      orderingKey,
      excludeBaseUris: [new URL(ctx.canonicalOrigin)],
      preferSharedInbox: true,
    },
  );
  return rows[0];
}

export interface ViewerReactionRow {
  postId: Uuid;
  emoji: string | null;
  customEmojiId: Uuid | null;
}

export async function getViewerReactionsForPosts(
  db: Database,
  postIds: readonly Uuid[],
  actor: Actor,
): Promise<ViewerReactionRow[]> {
  if (postIds.length < 1) return [];
  const rows = await db
    .select({
      postId: reactionTable.postId,
      emoji: reactionTable.emoji,
      customEmojiId: reactionTable.customEmojiId,
    })
    .from(reactionTable)
    .where(
      and(
        eq(reactionTable.actorId, actor.id),
        inArray(reactionTable.postId, postIds as Uuid[]),
      ),
    );
  return rows;
}

export async function updateReactionsCounts(
  db: Database,
  postId: Uuid,
): Promise<void> {
  await db.update(postTable)
    .set({
      reactionsCounts: sql`(
        SELECT coalesce(jsonb_object_agg(stats.emoji, stats.count), '{}')
        FROM (
          SELECT
            coalesce(
              ${reactionTable.emoji},
              ${reactionTable.customEmojiId}::text
            ),
            count(*)
          FROM ${reactionTable}
          WHERE ${reactionTable.postId} = ${postId}
          GROUP BY coalesce(
              ${reactionTable.emoji},
              ${reactionTable.customEmojiId}::text
            )
        ) AS stats(emoji, count)
      )`,
    })
    .where(eq(postTable.id, postId));
}
