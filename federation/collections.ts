import * as vocab from "@fedify/fedify/vocab";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  like,
  lte,
  or,
} from "drizzle-orm";
import { db } from "../db.ts";
import { toRecipient } from "../models/actor.ts";
import {
  accountTable,
  actorTable,
  followingTable,
  postTable,
} from "../models/schema.ts";
import { validateUuid } from "../models/uuid.ts";
import { federation } from "./federation.ts";
import { getPostRecipients } from "./objects.ts";

federation
  .setFollowersDispatcher(
    "/ap/actors/{identifier}/followers",
    async (ctx, identifier, cursor, filter) => {
      if (identifier === new URL(ctx.canonicalOrigin).hostname) {
        return { items: [] };
      }
      if (cursor == null && filter == null || !validateUuid(identifier)) {
        return null;
      }
      const account = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: eq(accountTable.id, identifier),
      });
      if (account == null) return null;
      const followers = await db.query.followingTable.findMany({
        with: { follower: true },
        where: and(
          eq(followingTable.followeeId, account.actor.id),
          isNotNull(followingTable.accepted),
          filter == null ? undefined : inArray(
            followingTable.followerId,
            db.select({ id: actorTable.id }).from(actorTable).where(
              like(actorTable.iri, `${filter.origin}/%`),
            ),
          ),
          cursor == null || cursor.trim() === ""
            ? undefined
            : gt(followingTable.accepted, new Date(cursor.trim())),
        ),
        orderBy: desc(followingTable.accepted),
        limit: cursor == null ? undefined : 100,
      });
      return {
        items: followers.map((follow) => toRecipient(follow.follower)),
        nextCursor: cursor == null || followers.length < 100
          ? null
          : followers[99].accepted?.toISOString(),
      };
    },
  )
  .setFirstCursor((_ctx, _identifier) => "")
  .setCounter(async (_ctx, identifier, filter) => {
    if (!validateUuid(identifier)) return null;
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

const OUTBOX_WINDOW = 50;

federation
  .setOutboxDispatcher(
    "/ap/actors/{identifier}/outbox",
    async (ctx, identifier, cursor) => {
      if (identifier === new URL(ctx.canonicalOrigin).hostname) {
        return { items: [] };
      }
      if (cursor == null || !validateUuid(identifier)) return null;
      const account = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: eq(accountTable.id, identifier),
      });
      if (account == null) return null;
      const posts = await db.query.postTable.findMany({
        with: {
          mentions: { with: { actor: true } },
          sharedPost: true,
        },
        where: and(
          eq(postTable.actorId, account.actor.id),
          or( // FIXME
            eq(postTable.visibility, "public"),
            eq(postTable.visibility, "unlisted"),
          ),
          validateUuid(cursor) ? lte(postTable.id, cursor) : undefined,
        ),
        orderBy: desc(postTable.id),
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
  .setCounter(async (_ctx, identifier) => {
    if (!validateUuid(identifier)) return null;
    const account = await db.query.accountTable.findFirst({
      with: { actor: true },
      where: eq(accountTable.id, identifier),
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
