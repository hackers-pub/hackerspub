import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import {
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import { assertNever } from "@std/assert/unstable-never";
import DataLoader from "dataloader";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  createAvatarMediumFromMedium,
  createAvatarMediumFromUrl,
  getAvatarUrl,
  updateAccount,
} from "@hackerspub/models/account";
import { syncActorFromAccount } from "@hackerspub/models/actor";
import type { Locale } from "@hackerspub/models/i18n";
import { renderMarkup } from "@hackerspub/models/markup";
import {
  accountTable,
  actorTable,
  notificationTable,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { Actor } from "./actor.ts";
import { builder, type UserContext } from "./builder.ts";
import { InvitationLink } from "./invitation-link.ts";
import { Notification } from "./notification.ts";
import { putProfileOgImage } from "./og.ts";
import { ArticleDraft } from "./post.ts";
import {
  fromPostVisibility,
  PostVisibility,
  toPostVisibility,
} from "./postvisibility.ts";

const profileOgImageComplexity = 2_000;

export const Account = builder.drizzleNode("accountTable", {
  name: "Account",
  description:
    "A local user account on this Hackers' Pub instance. Every `Account` " +
    "has exactly one `Actor` (its public ActivityPub identity) and holds " +
    "login credentials, settings, and moderation state. `Account` is only " +
    "returned for the authenticated viewer and for moderator-only queries; " +
    "all public identity data (name, bio, posts, followers) lives on `Actor`.",
  id: {
    column: (account) => account.id,
  },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    username: t.exposeString("username"),
    usernameChanged: t.expose("usernameChanged", {
      type: "DateTime",
      nullable: true,
      description:
        "When the username was last changed, or null if the username has " +
        "never been changed from the original signup value.",
    }),
    handle: t.string({
      description: "Full fediverse handle including the instance host, e.g., " +
        "@alice@hackers.pub. Suitable for display and for cross-instance " +
        "@-mention targeting.",
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
    avatarMediumId: t.expose("avatarMediumId", {
      type: "UUID",
      nullable: true,
      description: "UUID of the medium used as this account's avatar.",
    }),
    avatarUrl: t.field({
      type: "URL",
      deprecationReason: "Use avatarMediumId instead.",
      select: {
        columns: {
          avatarMediumId: true,
        },
        with: {
          avatarMedium: true,
          emails: true,
        },
      },
      async resolve(account, _, ctx) {
        const url = await getAvatarUrl(ctx.disk, account);
        return new URL(url);
      },
    }),
    ogImageUrl: t.field({
      type: "URL",
      complexity: profileOgImageComplexity,
      select: {
        columns: {
          avatarMediumId: true,
          bio: true,
          id: true,
          name: true,
          ogImageKey: true,
          username: true,
        },
        with: {
          avatarMedium: true,
          actor: {
            columns: {
              handleHost: true,
            },
          },
          emails: true,
        },
      },
      async resolve(account, _, ctx) {
        const avatarUrl = await getAvatarUrl(ctx.disk, account);
        const bio = await renderMarkup(ctx.fedCtx, account.bio, {
          kv: ctx.kv,
        });
        const handle = `@${account.username}@${account.actor.handleHost}`;
        const key = await putProfileOgImage(ctx.disk, account.ogImageKey, {
          avatarKey: account.avatarMedium?.key ?? avatarUrl,
          avatarUrl,
          bio: bio.text,
          displayName: account.name,
          handle,
        });
        if (key !== account.ogImageKey) {
          await ctx.db.update(accountTable)
            .set({ ogImageKey: key })
            .where(eq(accountTable.id, account.id));
        }
        return new URL(await ctx.disk.getUrl(key));
      },
    }),
    locales: t.field({
      type: ["Locale"],
      nullable: true,
      description:
        "The account's preferred display languages as BCP 47 tags. " +
        "null means no preference has been set and all languages are shown.",
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
      description:
        "Whether to show LLM-generated article summaries by default. " +
        "Only visible to the account holder and moderators.",
    }),
    defaultNoteVisibility: t.field({
      type: PostVisibility,
      description:
        "The visibility applied to new notes when the user does not " +
        "choose one explicitly at creation time.",
      select: {
        columns: { noteVisibility: true },
      },
      resolve(account) {
        return toPostVisibility(account.noteVisibility);
      },
    }),
    defaultShareVisibility: t.field({
      type: PostVisibility,
      description:
        "The visibility applied to new boosts/shares when the user does " +
        "not choose one explicitly at creation time.",
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
    unreadNotificationsCount: t.int({
      description: "Number of notifications created after the account's last " +
        "`markNotificationsAsRead` call. Only visible to the account holder.",
      authScopes: (parent) => ({
        selfAccount: parent.id,
      }),
      select: {
        columns: {
          id: true,
        },
      },
      resolve(account, _, ctx) {
        return ctx.db.$count(
          notificationTable,
          and(
            eq(notificationTable.accountId, account.id),
            sql`${notificationTable.created} > COALESCE(
              (
                SELECT ${accountTable.notificationRead}
                FROM ${accountTable}
                WHERE ${accountTable.id} = ${account.id}
              ),
              '-infinity'::timestamptz
            )`,
            gt(
              ctx.db.$count(
                actorTable,
                sql`${actorTable.id} = ANY(${notificationTable.actorIds})`,
              ),
              0,
            ),
          ),
        );
      },
    }),
  }),
});

builder.drizzleObjectField(Account, "invitationLinks", (t) =>
  t.field({
    type: [InvitationLink],
    authScopes: (parent) => ({
      moderator: true,
      selfAccount: parent.id,
    }),
    select: {
      columns: { id: true },
      with: {
        invitationLinks: {
          orderBy: { created: "desc" },
        },
      },
    },
    resolve(account) {
      return account.invitationLinks;
    },
  }));

const accountConnectionHelpers = drizzleConnectionHelpers(
  builder,
  "accountTable",
  {
    resolveNode: (account) => account,
  },
);

// Per-request batching loader for invitee counts.  Without this,
// listing accounts on the admin table (or any other place that
// requests `Account.invitees(first: 0).totalCount` per row) fans
// out to one COUNT(*) query per account.
function getInviteeCount(ctx: UserContext, accountId: string): Promise<number> {
  ctx.inviteeCountLoader ??= new DataLoader<Uuid, number>(async (ids) => {
    const idList = ids as Uuid[];
    const rows = await ctx.db
      .select({
        inviterId: accountTable.inviterId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(accountTable)
      .where(inArray(accountTable.inviterId, idList))
      .groupBy(accountTable.inviterId);
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row.inviterId == null) continue;
      map.set(row.inviterId, Number(row.count));
    }
    return idList.map((id) => map.get(id) ?? 0);
  });
  if (!validateUuid(accountId)) return Promise.resolve(0);
  return ctx.inviteeCountLoader.load(accountId);
}

builder.drizzleObjectField(Account, "invitees", (t) =>
  t.connection(
    {
      type: Account,
      select: (args, ctx, nestedSelection) => ({
        with: {
          invitees: accountConnectionHelpers.getQuery(
            args,
            ctx,
            nestedSelection,
          ),
        },
      }),
      async resolve(account, args, ctx) {
        return {
          ...accountConnectionHelpers.resolve(account.invitees, args, ctx),
          totalCount: await getInviteeCount(ctx, account.id),
        };
      },
    },
    {
      fields: (t) => ({
        totalCount: t.exposeInt("totalCount"),
      }),
    },
  ));

builder.drizzleObjectField(
  Account,
  "articleDrafts",
  (t) =>
    t.relatedConnection("articleDrafts", {
      type: ArticleDraft,
      authScopes: (parent) => ({
        selfAccount: "id" in parent ? parent.id : undefined,
      }),
      query: () => ({
        orderBy: { updated: "desc" },
      }),
    }),
);

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
  accounts: t.drizzleField({
    type: [Account],
    resolve(query, _, __, ctx) {
      return ctx.db.query.accountTable.findMany(query());
    },
  }),
}));

interface InvitationTreeNode {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string;
  inviterId: string | null;
  hidden: boolean;
}

const DEFAULT_AVATAR_URL = "https://gravatar.com/avatar/?d=mp&s=128";

const InvitationTreeNodeRef = builder.objectRef<InvitationTreeNode>(
  "InvitationTreeNode",
);

InvitationTreeNodeRef.implement({
  description: "A node in the invitation tree.",
  fields: (t) => ({
    id: t.exposeID("id"),
    username: t.exposeString("username", { nullable: true }),
    name: t.exposeString("name", { nullable: true }),
    avatarUrl: t.field({
      type: "URL",
      resolve: (node) => new URL(node.avatarUrl),
    }),
    inviterId: t.exposeID("inviterId", { nullable: true }),
    hidden: t.exposeBoolean("hidden"),
  }),
});

builder.queryField("invitationTree", (t) =>
  t.field({
    type: [InvitationTreeNodeRef],
    description:
      "Returns all accounts as a flat array for building the invitation tree.",
    async resolve(_, __, ctx) {
      const accounts = await ctx.db.query.accountTable.findMany({
        with: {
          actor: true,
          avatarMedium: true,
          emails: true,
        },
      });

      return await Promise.all(
        accounts.map(async (account) => ({
          id: account.id,
          username: account.hideFromInvitationTree ? null : account.username,
          name: account.hideFromInvitationTree ? null : account.name,
          avatarUrl: account.hideFromInvitationTree
            ? DEFAULT_AVATAR_URL
            : await getAvatarUrl(ctx.disk, account),
          inviterId: account.inviterId,
          hidden: account.hideFromInvitationTree,
        })),
      );
    },
  }));

const AccountLinkInput = builder.inputType("AccountLinkInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    url: t.field({ type: "URL", required: true }),
  }),
});

builder.relayMutationField(
  "updateAccount",
  {
    inputFields: (t) => ({
      id: t.globalID({ for: Account, required: true }),
      username: t.string(),
      name: t.string(),
      bio: t.string(),
      avatarUrl: t.field({
        type: "URL",
        deprecationReason: "Use avatarMediumId instead.",
      }),
      avatarMediumId: t.field({ type: "UUID" }),
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
      let avatarMediumId: Uuid | undefined;
      if (args.input.avatarUrl != null) {
        if (args.input.avatarMediumId != null) {
          throw new Error(
            "avatarUrl and avatarMediumId are mutually exclusive.",
          );
        }
        const medium = await createAvatarMediumFromUrl(
          ctx.db,
          ctx.disk,
          args.input.avatarUrl,
          { userAgentUrl: new URL(ctx.fedCtx.canonicalOrigin) },
        );
        if (medium == null) {
          throw new Error("Avatar URL must point to an image.");
        }
        avatarMediumId = medium.id;
      } else if (args.input.avatarMediumId != null) {
        const medium = await ctx.db.query.mediumTable.findFirst({
          where: { id: args.input.avatarMediumId },
        });
        if (medium == null) throw new Error("Medium not found.");
        const avatarMedium = await createAvatarMediumFromMedium(
          ctx.db,
          ctx.disk,
          medium,
        );
        if (avatarMedium == null) {
          throw new Error("Avatar medium must point to an image.");
        }
        avatarMediumId = avatarMedium.id;
      }
      const result = await updateAccount(
        ctx.fedCtx,
        {
          id: args.input.id.id,
          username: args.input.username ?? undefined,
          name: args.input.name ?? undefined,
          bio: args.input.bio ?? undefined,
          avatarMediumId,
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
      if (result == null) throw new Error("Account not found");
      const emails = await ctx.db.query.accountEmailTable.findMany({
        where: { accountId: result.id },
      });
      const avatarMedium = result.avatarMediumId == null
        ? null
        : await ctx.db.query.mediumTable.findFirst({
          where: { id: result.avatarMediumId },
        }) ?? null;
      await syncActorFromAccount(ctx.fedCtx, {
        ...result,
        emails,
        avatarMedium,
      });
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
