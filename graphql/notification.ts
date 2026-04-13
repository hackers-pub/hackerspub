import {
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import { Actor } from "./actor.ts";
import { builder, Node } from "./builder.ts";
import { Post } from "./post.ts";

export const NotificationType = builder.enumType("NotificationType", {
  values: [
    "FOLLOW",
    "MENTION",
    "REPLY",
    "SHARE",
    "QUOTE",
    "REACT",
  ] as const,
});

export const Notification = builder.drizzleInterface("notificationTable", {
  variant: "Notification",
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
          async ({ limit }: ResolveCursorConnectionArgs) => {
            const actors = await ctx.db.query.actorTable.findMany({
              where: {
                id: { in: notification.actorIds },
              },
            });
            const positionMap = new Map(
              notification.actorIds.map((id, index) => [id, index]),
            );
            actors.sort((a, b) =>
              (positionMap.get(b.id) ?? -1) -
              (positionMap.get(a.id) ?? -1)
            );
            return actors.slice(0, limit);
          },
        );
      },
    }),
  }),
});

export const FollowNotification = builder.drizzleNode("notificationTable", {
  variant: "FollowNotification",
  interfaces: [Notification],
  id: {
    column: (notification) => notification.id,
  },
});

export const MentionNotification = builder.drizzleNode(
  "notificationTable",
  {
    variant: "MentionNotification",
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
