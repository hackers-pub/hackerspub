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
import { OrganizationConversionRequestRef } from "./organization-conversion-request.ts";
import { OrganizationMembershipRef } from "./organization-membership.ts";
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
    SHARED_POST_UPDATED: {
      description:
        "An author updated a post that this account previously boosted (reshared).",
    },
    QUOTED_POST_UPDATED: {
      description:
        "An author updated a post that this account previously quoted.",
    },
    REACT: {
      description:
        "Someone reacted with an emoji to one of this account's posts.",
    },
    POLL_ENDED: {
      description:
        "A `Question` poll this account authored or voted in has ended.",
    },
    ORGANIZATION_INVITATION: {
      description:
        "An organization invited this personal account to become a member.",
    },
    ORGANIZATION_CONVERSION_REQUEST: {
      description:
        "A personal account asked this account to accept its conversion " +
        "into an organization account.",
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
      case "shared_post_updated":
        return SharedPostUpdatedNotification.name;
      case "quoted_post_updated":
        return QuotedPostUpdatedNotification.name;
      case "react":
        return ReactNotification.name;
      case "poll_ended":
        return PollEndedNotification.name;
      case "organization_invitation":
        return OrganizationInvitationNotification.name;
      case "organization_conversion_request":
        return OrganizationConversionRequestNotification.name;
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
            actors.sort(
              (a, b) =>
                (positionMap.get(b.id) ?? -1) - (positionMap.get(a.id) ?? -1),
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

export const MentionNotification = builder.drizzleNode("notificationTable", {
  variant: "MentionNotification",
  description: "Notification that an actor @-mentioned this account in a post.",
  interfaces: [Notification],
  id: {
    column: (notification) => notification.id,
  },
  fields: (t) => ({
    post: t.relation("post", { type: Post, nullable: true }),
  }),
});

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

export const SharedPostUpdatedNotification = builder.drizzleNode(
  "notificationTable",
  {
    variant: "SharedPostUpdatedNotification",
    description:
      "Notification that the author updated a post this account previously boosted (reshared).",
    interfaces: [Notification],
    id: {
      column: (notification) => notification.id,
    },
    fields: (t) => ({
      post: t.relation("post", {
        type: Post,
        nullable: true,
        description:
          "The updated post. This may be `null` if the post was deleted after the notification was created.",
      }),
    }),
  },
);

export const QuotedPostUpdatedNotification = builder.drizzleNode(
  "notificationTable",
  {
    variant: "QuotedPostUpdatedNotification",
    description:
      "Notification that the author updated a post this account previously quoted.",
    interfaces: [Notification],
    id: {
      column: (notification) => notification.id,
    },
    fields: (t) => ({
      post: t.relation("post", {
        type: Post,
        nullable: true,
        description:
          "The updated post. This may be `null` if the post was deleted after the notification was created.",
      }),
    }),
  },
);

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

export const PollEndedNotification = builder.drizzleNode("notificationTable", {
  variant: "PollEndedNotification",
  description:
    "Notification that a `Question` poll this account authored or voted in has ended.",
  interfaces: [Notification],
  id: {
    column: (notification) => notification.id,
  },
  fields: (t) => ({
    post: t.relation("post", {
      type: Post,
      nullable: true,
      description:
        "The ended `Question` post. This may be `null` if the post was deleted after the notification was created.",
    }),
  }),
});

export const OrganizationConversionRequestNotification = builder.drizzleNode(
  "notificationTable",
  {
    variant: "OrganizationConversionRequestNotification",
    description:
      "Notification asking the account holder to accept another account's " +
      "irreversible conversion into an organization account.",
    interfaces: [Notification],
    id: {
      column: (notification) => notification.id,
    },
    fields: (t) => ({
      request: t.field({
        type: OrganizationConversionRequestRef,
        description:
          "The conversion request that can be accepted by this notification's " +
          "recipient.",
        async resolve(notification, _, ctx) {
          const requestId = notification.organizationConversionRequestId;
          if (requestId == null) throw new InvalidInputError("request");
          const request =
            await ctx.db.query.organizationConversionRequestTable.findFirst({
              where: { id: requestId },
            });
          if (request == null) throw new InvalidInputError("request");
          return request;
        },
      }),
    }),
  },
);

export const OrganizationInvitationNotification = builder.drizzleNode(
  "notificationTable",
  {
    variant: "OrganizationInvitationNotification",
    description:
      "Notification asking the account holder to accept an invitation to " +
      "join an organization account.",
    interfaces: [Notification],
    id: {
      column: (notification) => notification.id,
    },
    fields: (t) => ({
      membership: t.field({
        type: OrganizationMembershipRef,
        nullable: true,
        description:
          "The organization membership invitation represented by this " +
          "notification. This is `null` if the invitation was removed after " +
          "the notification was created.",
        async resolve(notification, _, ctx) {
          const organizationActorId = notification.actorIds[0];
          if (organizationActorId == null) return null;
          const organizationActor = await ctx.db.query.actorTable.findFirst({
            where: { id: organizationActorId },
            columns: { accountId: true },
          });
          if (organizationActor?.accountId == null) return null;
          return (
            (await ctx.db.query.organizationMembershipTable.findFirst({
              where: {
                organizationAccountId: organizationActor.accountId,
                memberAccountId: notification.accountId,
              },
            })) ?? null
          );
        },
      }),
    }),
  },
);

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
      const readThrough =
        upTo == null
          ? sql`CURRENT_TIMESTAMP`
          : sql`(
          SELECT ${notificationTable.created}
          FROM ${notificationTable}
          WHERE ${notificationTable.id} = ${upTo}
            AND ${notificationTable.accountId} = ${ctx.account.id}
        )`;
      const [row] = await ctx.db
        .update(accountTable)
        .set({
          notificationRead: sql`GREATEST(
            COALESCE(${accountTable.notificationRead}, '-infinity'::timestamptz),
            ${readThrough}
          )`,
        })
        .where(
          and(
            eq(accountTable.id, ctx.account.id),
            upTo == null
              ? undefined
              : sql`EXISTS (
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
  }),
);
