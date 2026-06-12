import type { Context } from "@fedify/fedify";
import { LanguageString } from "@fedify/vocab";
import * as vocab from "@fedify/vocab";
import { toRecipient } from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import {
  getSanctionHiddenActorFilter,
  isActorSanctionHidden,
} from "@hackerspub/models/post";
import {
  actorTable,
  followingTable,
  type Mention,
  pinTable,
  type Post,
  postTable,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { builder } from "./builder.ts";
import { getCreate, getPostRecipients } from "./objects.ts";

const FOLLOWERS_WINDOW = 50;

builder
  .setFollowersDispatcher(
    "/ap/actors/{identifier}/followers",
    async (ctx, identifier, cursor, filter) => {
      if (identifier === new URL(ctx.canonicalOrigin).hostname) {
        return { items: [] };
      }
      if (!validateUuid(identifier)) return null;
      const { db } = ctx.data;
      const account = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: { id: identifier },
      });
      if (account == null) return null;
      const followers = await db.query.followingTable.findMany({
        with: { follower: true },
        where: {
          followeeId: account.actor.id,
          accepted: { isNotNull: true },
          ...(filter == null ? undefined : {
            follower: {
              iri: { like: `${filter.origin}/%` },
            },
          }),
          ...(
            cursor == null || cursor.trim() === ""
              ? undefined
              : { accepted: { lte: new Date(cursor.trim()) } }
          ),
        },
        orderBy: { accepted: "desc" },
        limit: cursor == null ? undefined : FOLLOWERS_WINDOW,
      });
      return {
        items: followers.map((follow) => toRecipient(follow.follower)),
        nextCursor: cursor == null || followers.length < FOLLOWERS_WINDOW
          ? null
          : followers[FOLLOWERS_WINDOW - 1].accepted?.toISOString(),
      };
    },
  )
  .setFirstCursor((_ctx, _identifier) => "")
  .setCounter(async (ctx, identifier, filter) => {
    if (!validateUuid(identifier)) return null;
    const { db } = ctx.data;
    const [{ cnt }] = await db.select({ cnt: count() })
      .from(followingTable)
      .innerJoin(actorTable, eq(followingTable.followeeId, actorTable.id))
      .where(and(
        eq(actorTable.accountId, identifier),
        isNotNull(followingTable.accepted),
        filter == null ? undefined : inArray(
          followingTable.followerId,
          db.select({ id: actorTable.id }).from(actorTable).where(
            like(actorTable.iri, `${filter.origin}/%`),
          ),
        ),
      ));
    return cnt;
  });

const FOLLOWEES_WINDOW = 50;

builder
  .setFollowingDispatcher(
    "/ap/actors/{identifier}/followees",
    async (ctx, identifier, cursor) => {
      if (identifier === new URL(ctx.canonicalOrigin).hostname) {
        return { items: [] };
      }
      if (!validateUuid(identifier)) return null;
      const { db } = ctx.data;
      const account = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: { id: identifier },
      });
      if (account == null) return null;
      const followees = await db.query.followingTable.findMany({
        with: { followee: true },
        where: {
          followerId: account.actor.id,
          accepted: { isNotNull: true },
          ...(
            cursor == null || cursor.trim() === ""
              ? undefined
              : { accepted: { lte: new Date(cursor.trim()) } }
          ),
        },
        orderBy: { accepted: "desc" },
        limit: cursor == null ? undefined : FOLLOWEES_WINDOW,
      });
      return {
        items: followees.map((follow) => new URL(follow.followee.iri)),
        nextCursor: cursor == null || followees.length < FOLLOWEES_WINDOW
          ? null
          : followees[FOLLOWEES_WINDOW - 1].accepted?.toISOString(),
      };
    },
  )
  .setFirstCursor((_ctx, _identifier) => "")
  .setCounter(async (ctx, identifier) => {
    if (!validateUuid(identifier)) return null;
    const [{ cnt }] = await ctx.data.db.select({ cnt: count() })
      .from(followingTable)
      .innerJoin(actorTable, eq(followingTable.followerId, actorTable.id))
      .where(and(
        eq(actorTable.accountId, identifier),
        isNotNull(followingTable.accepted),
      ));
    return cnt;
  });

export function toFeaturedCollectionItem(
  ctx: Context<ContextData>,
  post:
    & Pick<
      Post,
      | "contentHtml"
      | "iri"
      | "language"
      | "name"
      | "published"
      | "sensitive"
      | "summary"
      | "type"
      | "updated"
      | "url"
      | "visibility"
    >
    & {
      actor: { accountId: Uuid | null; iri?: string };
      mentions?: (Mention & { actor: { iri: string } })[];
      poll?: {
        ends: Date;
        multiple: boolean;
        options: {
          index: number;
          title: string;
          votesCount: number;
        }[];
        votersCount: number;
      } | null;
    },
): vocab.Article | vocab.Note | vocab.Question {
  const attribution = post.actor.accountId == null
    ? new URL(post.actor.iri ?? post.iri)
    : ctx.getActorUri(post.actor.accountId);
  const recipients = post.actor.accountId == null ? {} : getPostRecipients(
    ctx,
    post.actor.accountId,
    post.mentions?.map((mention) => new URL(mention.actor.iri)) ?? [],
    post.visibility,
  );
  const common = {
    id: new URL(post.iri),
    attribution,
    ...recipients,
    contents: [
      post.contentHtml,
      ...(post.language == null
        ? []
        : [new LanguageString(post.contentHtml, post.language)]),
    ],
    name: post.name,
    published: post.published.toTemporalInstant(),
    sensitive: post.sensitive,
    summary: post.summary,
    updated: +post.updated > +post.published
      ? post.updated.toTemporalInstant()
      : null,
    url: post.url == null ? null : new URL(post.url),
  };
  switch (post.type) {
    case "Article":
      return new vocab.Article(common);
    case "Note":
      return new vocab.Note(common);
    case "Question": {
      const options = post.poll?.options
        .sort((a, b) => a.index - b.index)
        .map((option) =>
          new vocab.Note({
            name: option.title,
            replies: new vocab.Collection({
              totalItems: option.votesCount,
            }),
          })
        ) ?? [];
      return new vocab.Question({
        ...common,
        endTime: post.poll?.ends.toTemporalInstant() ?? null,
        voters: post.poll?.votersCount ?? null,
        ...(post.poll?.multiple
          ? { inclusiveOptions: options }
          : { exclusiveOptions: options }),
      });
    }
  }
}

builder
  .setFeaturedDispatcher(
    "/ap/actors/{identifier}/featured",
    async (ctx, identifier) => {
      if (identifier === new URL(ctx.canonicalOrigin).hostname) {
        return { items: [] };
      }
      if (!validateUuid(identifier)) return null;
      const account = await ctx.data.db.query.accountTable.findFirst({
        with: { actor: true },
        where: { id: identifier },
      });
      if (account == null) return null;
      // The featured items embed full post content, so a sanction-hidden
      // actor's pins are not served at all.
      if (isActorSanctionHidden(account.actor)) return { items: [] };
      const pins = await ctx.data.db.query.pinTable.findMany({
        with: {
          post: {
            with: {
              actor: true,
              mentions: { with: { actor: true } },
              poll: { with: { options: true } },
            },
          },
        },
        where: {
          actorId: account.actor.id,
          post: {
            visibility: { in: ["public", "unlisted"] },
            // Censored content is not served over ActivityPub.
            censored: { isNull: true },
          },
        },
        orderBy: { created: "desc" },
      });
      return {
        items: pins.map((pin) => toFeaturedCollectionItem(ctx, pin.post)),
      };
    },
  )
  .setCounter(async (ctx, identifier) => {
    if (!validateUuid(identifier)) return null;
    const account = await ctx.data.db.query.accountTable.findFirst({
      with: { actor: true },
      where: { id: identifier },
    });
    if (account == null) return null;
    if (isActorSanctionHidden(account.actor)) return 0;
    const [{ cnt }] = await ctx.data.db.select({ cnt: count() })
      .from(pinTable)
      .innerJoin(actorTable, eq(pinTable.actorId, actorTable.id))
      .innerJoin(postTable, eq(pinTable.postId, postTable.id))
      .where(and(
        eq(actorTable.accountId, identifier),
        inArray(postTable.visibility, ["public", "unlisted"]),
        isNull(postTable.censored),
      ));
    return cnt;
  });

const OUTBOX_WINDOW = 50;

builder
  .setOutboxDispatcher(
    "/ap/actors/{identifier}/outbox",
    async (ctx, identifier, cursor) => {
      if (identifier === new URL(ctx.canonicalOrigin).hostname) {
        return { items: [] };
      }
      if (cursor == null || !validateUuid(identifier)) return null;
      const { db } = ctx.data;
      const account = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: { id: identifier },
      });
      if (account == null) return null;
      // A sanction-hidden actor's outbox is empty: remote servers polling
      // it must not receive content the sanction hides.
      if (isActorSanctionHidden(account.actor)) {
        return { items: [], nextCursor: null };
      }
      const posts = await db.query.postTable.findMany({
        with: {
          actor: { with: { account: true } },
          mentions: { with: { actor: true } },
          sharedPost: true,
        },
        where: {
          actorId: account.actor.id,
          visibility: { in: ["public", "unlisted"] }, // FIXME
          // Censored posts, boosts of censored posts, and boosts of
          // sanction-hidden actors' posts are not served over ActivityPub.
          censored: { isNull: true },
          NOT: {
            sharedPost: {
              OR: [
                { censored: { isNotNull: true } },
                { actor: getSanctionHiddenActorFilter() },
              ],
            },
          },
          ...(
            validateUuid(cursor) ? { id: { lte: cursor } } : undefined
          ),
        },
        orderBy: { id: "desc" },
        limit: OUTBOX_WINDOW + 1,
      });
      return {
        items: posts.slice(0, OUTBOX_WINDOW).flatMap(
          (post): (vocab.Create | vocab.Announce)[] => {
            if (post.sharedPost == null) {
              if (post.actor.account == null) return [];
              return [getCreate(ctx, {
                ...post,
                actor: { ...post.actor, account: post.actor.account },
              })];
            }
            return [
              new vocab.Announce({
                id: ctx.getObjectUri(vocab.Announce, { id: post.id }),
                actor: new URL(account.actor.iri),
                ...getPostRecipients(
                  ctx,
                  account.id,
                  post.mentions.map((m) => new URL(m.actor.iri)),
                  post.visibility,
                ),
                object: new URL(post.sharedPost.iri),
                published: post.published.toTemporalInstant(),
              }),
            ];
          },
        ),
        nextCursor: posts.length <= OUTBOX_WINDOW
          ? null
          : posts[OUTBOX_WINDOW].id,
      };
    },
  )
  .setFirstCursor((_ctx, _identifier) => "")
  .setCounter(async (ctx, identifier) => {
    if (!validateUuid(identifier)) return null;
    const { db } = ctx.data;
    const account = await db.query.accountTable.findFirst({
      with: { actor: true },
      where: { id: identifier },
    });
    if (account == null) return null;
    if (isActorSanctionHidden(account.actor)) return 0;
    const sharedPost = alias(postTable, "shared_post");
    const sharedActor = alias(actorTable, "shared_actor");
    const [{ cnt }] = await db.select({ cnt: count() })
      .from(postTable)
      .leftJoin(sharedPost, eq(postTable.sharedPostId, sharedPost.id))
      .leftJoin(sharedActor, eq(sharedPost.actorId, sharedActor.id))
      .where(and(
        eq(postTable.actorId, account.actor.id),
        or( // FIXME
          eq(postTable.visibility, "public"),
          eq(postTable.visibility, "unlisted"),
        ),
        isNull(postTable.censored),
        isNull(sharedPost.censored),
        // Boosts of sanction-hidden actors' posts are excluded; the raw
        // SQL mirrors isActorSanctionHidden (NULL-safe: non-boost rows
        // and unsanctioned actors match).
        sql`(
          ${sharedActor.id} is null
          or ${sharedActor.suspended} is null
          or ${sharedActor.suspended} > now()
          or ${sharedActor.suspendedUntil} <= now()
          or (${sharedActor.accountId} is not null
            and ${sharedActor.suspendedUntil} > now())
        )`,
      ));
    return cnt;
  });
