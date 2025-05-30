import * as vocab from "@fedify/fedify/vocab";
import { toRecipient } from "@hackerspub/models/actor";
import {
  actorTable,
  followingTable,
  postTable,
} from "@hackerspub/models/schema";
import { validateUuid } from "@hackerspub/models/uuid";
import { and, count, eq, inArray, isNotNull, like, or } from "drizzle-orm";
import { builder } from "./builder.ts";
import { getPostRecipients } from "./objects.ts";

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
      const posts = await db.query.postTable.findMany({
        with: {
          mentions: { with: { actor: true } },
          sharedPost: true,
        },
        where: {
          actorId: account.actor.id,
          visibility: { in: ["public", "unlisted"] }, // FIXME
          ...(
            validateUuid(cursor) ? { id: { lte: cursor } } : undefined
          ),
        },
        orderBy: { id: "desc" },
        limit: OUTBOX_WINDOW + 1,
      });
      return {
        items: posts.slice(0, OUTBOX_WINDOW).map((post) => {
          const recipients = getPostRecipients(
            ctx,
            account.id,
            post.mentions.map((m) => new URL(m.actor.iri)),
            post.visibility,
          );
          return post.sharedPost == null
            ? new vocab.Create({
              id: new URL("#crate", post.iri),
              actor: new URL(account.actor.iri),
              ...recipients,
              object: new URL(post.iri),
            })
            : new vocab.Announce({
              id: ctx.getObjectUri(vocab.Announce, { id: post.id }),
              actor: new URL(account.actor.iri),
              ...recipients,
              object: new URL(post.sharedPost.iri),
              published: post.published.toTemporalInstant(),
            });
        }),
        nextCursor: posts.length < OUTBOX_WINDOW
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
    const [{ cnt }] = await db.select({ cnt: count() })
      .from(postTable)
      .where(and(
        eq(postTable.actorId, account.actor.id),
        or( // FIXME
          eq(postTable.visibility, "public"),
          eq(postTable.visibility, "unlisted"),
        ),
      ));
    return cnt;
  });
