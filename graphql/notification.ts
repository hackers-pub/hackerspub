import {
  accountTable,
  type Actor as ActorRow,
  notificationTable,
} from "@hackerspub/models/schema";
import {
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import { and, eq, sql } from "drizzle-orm";
import { Actor, getActorById } from "./actor.ts";
import { builder, Node } from "./builder.ts";
import { InvalidInputError } from "./error.ts";
import { Post } from "./post.ts";
import { NotAuthenticatedError } from "./session.ts";

export const NotificationType = builder.enumType("NotificationType", {
  description:
    "Discriminant values for categorizing notifications. The Notification " +
    "interface is polymorphic; use this enum when filtering by category.",
  values: {
    FOLLOW: { description: "Someone followed this account." },
    MENTION: {
      description: "Someone @-mentioned this account in a post.",
    },
    REPLY: {
      description: "Someone replied to one of this account's posts.",
    },
    SHARE: {
      description: "Someone boosted (reshared) one of this account's posts.",
    },
    QUOTE: {
      description: "Someone quoted one of this account's posts.",
    },
    REACT: {
      description:
        "Someone reacted with an emoji to one of this account's posts.",
    },
  } as const,
});

export const Notification = builder.drizzleInterface("notificationTable", {
  variant: "Notification",
  description:
    "A notification for the account holder about social activity related " +
    "to their posts or profile. Multiple actors can trigger the same " +
    "notification (e.g., several people reacting to the same post are " +
    "merged). The `actors` field lists them newest-first.",
  interfaces: [Node],
  resolveType(notification): string {
    switch (notification.type) {
      case "follow":
        return FollowNotification.name;
      case "mention":
        return MentionNotification.name;
      case "reply":
        return ReplyNotification.name;
      case "share":
        return ShareNotification.name;
      case "quote":
        return QuoteNotification.name;
      case "react":
        return ReactNotification.name;
    }
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    created: t.expose("created", { type: "DateTime" }),
    account: t.relation("account"),
    actors: t.connection({
      type: Actor,
      resolve(notification, args, ctx) {
        return resolveCursorConnection(
          {
            args,
            toCursor: (actor) => actor.id,
          },
          async (_args: ResolveCursorConnectionArgs) => {
            // Dedupe actorIds before loading so the resolver matches the
            // prior `findMany({ id: { in: actorIds } })` behavior, which
            // implicitly returned each row at most once.  The notification
            // write path in models/notification.ts already prevents
            // duplicates, but the dedupe here defends the parity.
            const uniqueActorIds = [...new Set(notification.actorIds)];
            const loaded = await Promise.all(
              uniqueActorIds.map((id) => getActorById(ctx, id)),
            );
            const actors = loaded.filter(
              (actor): actor is ActorRow => actor != null,
            );
            const positionMap = new Map(
              notification.actorIds.map((id, index) => [id, index]),
            );
            actors.sort((a, b) =>
              (positionMap.get(b.id) ?? -1) -
              (positionMap.get(a.id) ?? -1)
            );
            return actors;
          },
        );
      },
    }),
  }),
});

export const FollowNotification = builder.drizzleNode("notificationTable", {
  variant: "FollowNotification",
  description: "Notification that one or more actors followed this account.",
  interfaces: [Notification],
  id: {
    column: (notification) => notification.id,
  },
});

export const MentionNotification = builder.drizzleNode(
  "notificationTable",
  {
    variant: "MentionNotification",
    description:
      "Notification that an actor @-mentioned this account in a post.",
    interfaces: [Notification],
    id: {
      column: (notification) => notification.id,
    },
    fields: (t) => ({
      post: t.relation("post", { type: Post, nullable: true }),
    }),
  },
);

export const ReplyNotification = builder.drizzleNode("notificationTable", {
  variant: "ReplyNotification",
  description:
    "Notification that an actor replied to one of this account's posts.",
  interfaces: [Notification],
  id: {
    column: (notification) => notification.id,
  },
  fields: (t) => ({
    post: t.relation("post", { type: Post, nullable: true }),
  }),
});

export const ShareNotification = builder.drizzleNode("notificationTable", {
  variant: "ShareNotification",
  description:
    "Notification that an actor boosted (reshared) one of this account's posts.",
  interfaces: [Notification],
  id: {
    column: (notification) => notification.id,
  },
  fields: (t) => ({
    post: t.relation("post", { type: Post, nullable: true }),
  }),
});

export const QuoteNotification = builder.drizzleNode("notificationTable", {
  variant: "QuoteNotification",
  description: "Notification that an actor quoted one of this account's posts.",
  interfaces: [Notification],
  id: {
    column: (notification) => notification.id,
  },
  fields: (t) => ({
    post: t.relation("post", { type: Post, nullable: true }),
  }),
});

export const ReactNotification = builder.drizzleNode("notificationTable", {
  variant: "ReactNotification",
  description:
    "Notification that one or more actors reacted with an emoji to one of " +
    "this account's posts. The `emoji` and `customEmoji` fields identify " +
    "which reaction triggered the notification.",
  interfaces: [Notification],
  id: {
    column: (notification) => notification.id,
  },
  fields: (t) => ({
    post: t.relation("post", { type: Post, nullable: true }),
    emoji: t.exposeString("emoji", { nullable: true }),
    customEmoji: t.relation("customEmoji", { nullable: true }),
  }),
});

builder.mutationField("markNotificationsAsRead", (t) =>
  t.field({
    type: "DateTime",
    description:
      "Marks notifications as read up to a notification, or the current time when omitted. Returns the timestamp.",
    args: {
      upTo: t.arg({
        type: "UUID",
        required: false,
        description:
          "The UUID of the newest loaded notification to mark as read through.  When omitted, marks notifications read through the current time.",
      }),
    },
    async resolve(_root, { upTo }, ctx) {
      if (ctx.account == null) throw new NotAuthenticatedError();
      const readThrough = upTo == null ? sql`CURRENT_TIMESTAMP` : sql`(
          SELECT ${notificationTable.created}
          FROM ${notificationTable}
          WHERE ${notificationTable.id} = ${upTo}
            AND ${notificationTable.accountId} = ${ctx.account.id}
        )`;
      const [row] = await ctx.db.update(accountTable)
        .set({
          notificationRead: sql`GREATEST(
            COALESCE(${accountTable.notificationRead}, '-infinity'::timestamptz),
            ${readThrough}
          )`,
        })
        .where(
          and(
            eq(accountTable.id, ctx.account.id),
            upTo == null ? undefined : sql`EXISTS (
                SELECT 1
                FROM ${notificationTable}
                WHERE ${notificationTable.id} = ${upTo}
                  AND ${notificationTable.accountId} = ${ctx.account.id}
              )`,
          ),
        )
        .returning({ notificationRead: accountTable.notificationRead });
      if (row == null) throw new InvalidInputError("upTo");
      return row.notificationRead!;
    },
  }));
