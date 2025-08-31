import {
  getAvatarUrl,
  transformAvatar,
  updateAccount,
} from "@hackerspub/models/account";
import type { Locale } from "@hackerspub/models/i18n";
import {
  accountTable,
  actorTable,
  notificationTable,
} from "@hackerspub/models/schema";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import {
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import { assertNever } from "@std/assert/unstable-never";
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { Actor } from "./actor.ts";
import { builder } from "./builder.ts";
import { Notification } from "./notification.ts";
import {
  fromPostVisibility,
  PostVisibility,
  toPostVisibility,
} from "./postvisibility.ts";

export const Account = builder.drizzleNode("accountTable", {
  name: "Account",
  id: {
    column: (account) => account.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    username: t.exposeString("username"),
    usernameChanged: t.expose("usernameChanged", {
      type: "DateTime",
      nullable: true,
    }),
    handle: t.string({
      select: {
        columns: {
          username: true,
        },
        with: {
          actor: {
            columns: {
              handleHost: true,
            },
          },
        },
      },
      resolve(account, _, _ctx) {
        return `@${account.username}@${account.actor.handleHost}`;
      },
    }),
    name: t.exposeString("name"),
    bio: t.expose("bio", { type: "Markdown" }),
    avatarUrl: t.field({
      type: "URL",
      select: {
        columns: {
          avatarKey: true,
        },
        with: {
          emails: true,
        },
      },
      async resolve(account, _, ctx) {
        const url = await getAvatarUrl(ctx.disk, account);
        return new URL(url);
      },
    }),
    locales: t.field({
      type: ["Locale"],
      nullable: true,
      select: {
        columns: {
          locales: true,
        },
      },
      async resolve(account, _, _ctx) {
        if (account.locales == null) return null;
        return account.locales.map((loc) => new Intl.Locale(loc));
      },
    }),
    moderator: t.exposeBoolean("moderator"),
    invitationsLeft: t.exposeInt("leftInvitations", {
      authScopes: (parent) => ({
        moderator: true,
        selfAccount: parent.id,
      }),
    }),
    preferAiSummary: t.exposeBoolean("preferAiSummary", {
      authScopes: (parent) => ({
        moderator: true,
        selfAccount: parent.id,
      }),
    }),
    defaultNoteVisibility: t.field({
      type: PostVisibility,
      select: {
        columns: { noteVisibility: true },
      },
      resolve(account) {
        return toPostVisibility(account.noteVisibility);
      },
    }),
    defaultShareVisibility: t.field({
      type: PostVisibility,
      select: {
        columns: { shareVisibility: true },
      },
      resolve(account) {
        return toPostVisibility(account.shareVisibility);
      },
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    created: t.expose("created", { type: "DateTime" }),
    actor: t.relation("actor", { type: Actor }),
    links: t.relation("links", {
      type: AccountLink,
      query: {
        orderBy: { index: "asc" },
      },
    }),
    inviter: t.relation("inviter", { nullable: true }),
    notifications: t.connection({
      type: Notification,
      authScopes: (parent) => ({
        selfAccount: parent.id,
      }),
      async resolve(account, args, ctx) {
        return resolveCursorConnection(
          {
            args,
            toCursor: (notification) =>
              notification.created.valueOf().toString(),
          },
          async (
            { before, after, limit, inverted }: ResolveCursorConnectionArgs,
          ) => {
            // NOTE: the notification with latest "created" timestamp is the first
            //       and the notification with the oldest "created" timestamp is the last.
            const beforeDate = new Date(Number(before));
            const afterDate = new Date(Number(after));

            return await ctx.db
              .select()
              .from(notificationTable)
              .where(
                and(
                  eq(notificationTable.accountId, account.id),
                  before
                    ? inverted
                      ? lt(notificationTable.created, beforeDate)
                      : gt(notificationTable.created, beforeDate)
                    : undefined,
                  after
                    ? inverted
                      ? gt(notificationTable.created, afterDate)
                      : lt(notificationTable.created, afterDate)
                    : undefined,
                  gt(
                    ctx.db
                      .$count(
                        actorTable,
                        sql`${actorTable.id} = ANY(${notificationTable.actorIds})`,
                      ),
                    0,
                  ),
                ),
              )
              .orderBy(
                inverted
                  ? notificationTable.created
                  : desc(notificationTable.created),
              ).limit(limit);
          },
        );
      },
    }),
  }),
});

const accountConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "accountTable",
  {
    resolveNode: (account) => account,
  },
);

builder.drizzleObjectField(Account, "invitees", (t) =>
  t.connection(
    {
      type: Account,
      select: {
        with: {
          invitees: true,
        },
      },
      async resolve(account, args, ctx) {
        return {
          ...accountConnectionHelpers.resolve(account.invitees, args, ctx),
          totalCount: await ctx.db.$count(
            accountTable,
            eq(accountTable.inviterId, account.id),
          ),
        };
      },
    },
    {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    },
  ));

const AccountLinkIcon = builder.enumType("AccountLinkIcon", {
  values: [
    "ACTIVITYPUB",
    "AKKOMA",
    "BLUESKY",
    "CODEBERG",
    "DEV",
    "DISCORD",
    "FACEBOOK",
    "GITHUB",
    "GITLAB",
    "HACKERNEWS",
    "HOLLO",
    "INSTAGRAM",
    "KEYBASE",
    "LEMMY",
    "LINKEDIN",
    "LOBSTERS",
    "MASTODON",
    "MATRIX",
    "MISSKEY",
    "PIXELFED",
    "PLEROMA",
    "QIITA",
    "REDDIT",
    "SOURCEHUT",
    "THREADS",
    "VELOG",
    "WEB",
    "WIKIPEDIA",
    "X",
    "ZENN",
  ] as const,
});

export const AccountLink = builder.drizzleNode("accountLinkTable", {
  name: "AccountLink",
  id: {
    column: (link) => [link.accountId, link.index],
  },
  fields: (t) => ({
    index: t.exposeInt("index"),
    name: t.exposeString("name"),
    url: t.field({
      type: "URL",
      select: {
        columns: { url: true },
      },
      resolve(link) {
        return new URL(link.url);
      },
    }),
    handle: t.exposeString("handle", { nullable: true }),
    icon: t.field({
      type: AccountLinkIcon,
      select: {
        columns: { icon: true },
      },
      resolve(link) {
        switch (link.icon) {
          case "activitypub":
            return "ACTIVITYPUB";
          case "akkoma":
            return "AKKOMA";
          case "bluesky":
            return "BLUESKY";
          case "codeberg":
            return "CODEBERG";
          case "dev":
            return "DEV";
          case "discord":
            return "DISCORD";
          case "facebook":
            return "FACEBOOK";
          case "github":
            return "GITHUB";
          case "gitlab":
            return "GITLAB";
          case "hackernews":
            return "HACKERNEWS";
          case "hollo":
            return "HOLLO";
          case "instagram":
            return "INSTAGRAM";
          case "keybase":
            return "KEYBASE";
          case "lemmy":
            return "LEMMY";
          case "linkedin":
            return "LINKEDIN";
          case "lobsters":
            return "LOBSTERS";
          case "mastodon":
            return "MASTODON";
          case "matrix":
            return "MATRIX";
          case "misskey":
            return "MISSKEY";
          case "pixelfed":
            return "PIXELFED";
          case "pleroma":
            return "PLEROMA";
          case "qiita":
            return "QIITA";
          case "reddit":
            return "REDDIT";
          case "sourcehut":
            return "SOURCEHUT";
          case "threads":
            return "THREADS";
          case "velog":
            return "VELOG";
          case "web":
            return "WEB";
          case "wikipedia":
            return "WIKIPEDIA";
          case "x":
            return "X";
          case "zenn":
            return "ZENN";
          default:
            assertNever(link.icon, `Unknown icon: ${link.icon}`);
        }
      },
    }),
    verified: t.expose("verified", { type: "DateTime", nullable: true }),
    created: t.expose("created", { type: "DateTime" }),
  }),
});

builder.queryFields((t) => ({
  viewer: t.drizzleField({
    type: Account,
    nullable: true,
    async resolve(query, _, __, ctx) {
      const session = await ctx.session;
      if (session == null) return null;
      return await ctx.db.query.accountTable.findFirst(
        query({ where: { id: session.accountId } }),
      );
    },
  }),
  accountByUsername: t.drizzleField({
    type: Account,
    args: {
      username: t.arg.string({ required: true }),
    },
    nullable: true,
    resolve(query, _, { username }, ctx) {
      return ctx.db.query.accountTable.findFirst(
        query({ where: { username } }),
      );
    },
  }),
}));

const AccountLinkInput = builder.inputType("AccountLinkInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    url: t.field({ type: "URL", required: true }),
  }),
});

const SUPPORTED_AVATAR_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

builder.relayMutationField(
  "updateAccount",
  {
    inputFields: (t) => ({
      id: t.globalID({ for: Account, required: true }),
      username: t.string(),
      name: t.string(),
      bio: t.string(),
      avatarUrl: t.field({ type: "URL" }),
      locales: t.field({ type: ["Locale"] }),
      hideFromInvitationTree: t.boolean(),
      hideForeignLanguages: t.boolean(),
      preferAiSummary: t.boolean(),
      defaultNoteVisibility: t.field({ type: PostVisibility }),
      defaultShareVisibility: t.field({ type: PostVisibility }),
      links: t.field({
        type: [AccountLinkInput],
      }),
    }),
  },
  {
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new Error("Not authenticated.");
      else if (session.accountId !== args.input.id.id) {
        throw new Error("Not authorized.");
      }
      const account = await ctx.db.query.accountTable.findFirst({
        where: {
          id: args.input.id.id,
        },
      });
      if (account == null) throw new Error("Account not found.");
      if (args.input.username != null && account.usernameChanged != null) {
        throw new Error(
          "Username cannot be changed after it has been changed.",
        );
      }
      let avatarKey: string | undefined;
      const promises: Promise<void>[] = [];
      if (args.input.avatarUrl != null) {
        const response = await fetch(args.input.avatarUrl);
        if (response.status !== 200) {
          throw new Error("Failed to fetch the avatar URL.");
        }
        const contentType = response.headers.get("Content-Type");
        if (
          contentType == null || !SUPPORTED_AVATAR_TYPES.includes(contentType)
        ) {
          throw new Error("Avatar URL must point to an image.");
        }
        const disk = ctx.disk;
        if (account.avatarKey != null) {
          promises.push(disk.delete(account.avatarKey));
        }
        const { buffer, format } = await transformAvatar(
          await response.arrayBuffer(),
        );
        const key = `avatars/${crypto.randomUUID()}.${
          format === "jpeg" ? "jpg" : format
        }`;
        promises.push(disk.put(key, buffer));
        avatarKey = key;
      }
      const result = await updateAccount(
        ctx.fedCtx,
        {
          id: args.input.id.id,
          username: args.input.username ?? undefined,
          name: args.input.name ?? undefined,
          bio: args.input.bio ?? undefined,
          avatarKey,
          locales: args.input.locales?.map((loc) => loc.baseName as Locale) ??
            undefined,
          hideFromInvitationTree: args.input.hideFromInvitationTree ??
            undefined,
          hideForeignLanguages: args.input.hideForeignLanguages ?? undefined,
          preferAiSummary: args.input.preferAiSummary ?? undefined,
          noteVisibility: args.input.defaultNoteVisibility == null
            ? undefined
            : fromPostVisibility(args.input.defaultNoteVisibility),
          shareVisibility: args.input.defaultShareVisibility == null
            ? undefined
            : fromPostVisibility(args.input.defaultShareVisibility),
          links: args.input.links ?? undefined,
        },
      );
      await Promise.all(promises);
      if (result == null) throw new Error("Account not found");
      return result;
    },
  },
  {
    outputFields: (t) => ({
      account: t.field({
        type: Account,
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);
