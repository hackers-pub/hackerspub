import { isActor } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import {
  encodeGlobalID,
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import { assertNever } from "@std/assert/unstable-never";
import DataLoader from "dataloader";
import { and, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  AccountDeletionUnavailableError,
  createAvatarMediumFromMedium,
  createAvatarMediumFromUrl,
  deleteAccount as deleteAccountModel,
  getAvatarUrl,
  isUsernameReserved,
  sendAccountActorUpdate,
  updateAccount,
} from "@hackerspub/models/account";
import { persistActor, syncActorFromAccount } from "@hackerspub/models/actor";
import type { Locale } from "@hackerspub/models/i18n";
import { renderMarkup } from "@hackerspub/models/markup";
import { deleteSession } from "@hackerspub/models/session";
import {
  accountTable,
  type Actor as ActorRow,
  actorTable,
  notificationTable,
  postTable,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { createGraphQLError } from "graphql-yoga";
import { Actor, isActorProfileHidden } from "./actor.ts";
import {
  type AdminAccountStats,
  builder,
  type UserContext,
} from "./builder.ts";
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import { InvitationLink } from "./invitation-link.ts";
import { lookupActorByUrl, parseHttpUrl } from "./lookup.ts";
import { Notification } from "./notification.ts";
import { putProfileOgImage } from "./og.ts";
import { ArticleDraft } from "./post.ts";
import {
  fromPostVisibility,
  PostVisibility,
  toPostVisibility,
} from "./postvisibility.ts";
import { fromQuotePolicy, QuotePolicy, toQuotePolicy } from "./quotepolicy.ts";
import {
  fromPushNotificationPreviewPolicy,
  PushNotificationPreviewPolicy,
  toPushNotificationPreviewPolicy,
} from "./push.ts";
import { NotAuthenticatedError } from "./session.ts";

const profileOgImageComplexity = 2_000;
const logger = getLogger(["hackerspub", "graphql", "account"]);

builder.objectType(AccountDeletionUnavailableError, {
  name: "AccountDeletionUnavailableError",
  description:
    "Returned when the account cannot be deleted because it is linked to " +
    "moderation audit records that must remain intact. The reason is " +
    "intentionally generic so clients do not expose moderation internals.",
  fields: (t) => ({
    unavailable: t.string({
      description:
        "Always an empty string. Use the type name for branching and show a " +
        "generic account-deletion-unavailable message.",
      resolve: () => "",
    }),
  }),
});

// Merge the GraphQL-derived selection for a related `Account` with the extra
// `hideFromInvitationTree` column so the inviter-gating resolver can read it
// regardless of which fields the caller requested.  Mirrors
// `selectPostRelationWithActor` in post.ts.  When no explicit column projection
// is present, all columns are already selected (which includes the flag), so
// the selection is left as-is.
function selectAccountWithHideFlag(
  nestedSelection: () => unknown,
): Record<string, unknown> {
  const selection = nestedSelection();
  if (selection == null || typeof selection !== "object") {
    return { columns: { hideFromInvitationTree: true } };
  }
  if (!("columns" in selection) || selection.columns == null) {
    return selection as Record<string, unknown>;
  }
  return {
    ...selection,
    columns: {
      ...(selection.columns as Record<string, unknown>),
      hideFromInvitationTree: true,
    },
  };
}

// The account's actor columns that `isActorProfileHidden` needs, merged
// into the selections of the public profile fields that a ban redacts.
const sanctionActorRelation = {
  columns: {
    id: true,
    suspended: true,
    suspendedUntil: true,
  },
} as const;

function parseActorHandle(raw: string): {
  handle: string;
  username: string;
  host: string;
} | null {
  const trimmed = raw.trim().replace(/^@/, "");
  const split = trimmed.split("@");
  if (split.length !== 2) return null;
  const username = split[0].trim();
  const host = split[1].trim();
  if (username === "" || host === "") return null;
  return { handle: `${username}@${host}`, username, host };
}

async function lookupActorByHandle(
  ctx: UserContext,
  raw: string,
): Promise<ActorRow | null> {
  const parsed = parseActorHandle(raw);
  if (parsed == null) return null;
  const existing = await ctx.db.query.actorTable.findFirst({
    where: {
      username: parsed.username,
      OR: [{ instanceHost: parsed.host }, { handleHost: parsed.host }],
    },
  });
  if (existing != null) return existing;
  if (ctx.account == null) return null;

  const documentLoader = await ctx.fedCtx.getDocumentLoader({
    identifier: ctx.account.id,
  });
  let object;
  try {
    object = await ctx.fedCtx.lookupObject(parsed.handle, { documentLoader });
  } catch {
    return null;
  }
  if (!isActor(object)) return null;
  return (await persistActor(ctx.fedCtx, object, { documentLoader })) ?? null;
}

async function lookupMigrationAliasActor(
  ctx: UserContext,
  raw: string,
): Promise<ActorRow | null> {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const url = parseHttpUrl(trimmed);
  if (url != null) return await lookupActorByUrl(ctx, url);
  return await lookupActorByHandle(ctx, trimmed);
}

async function getAuthorizedMigrationAccount(
  ctx: UserContext,
  accountId: string,
) {
  const session = await ctx.session;
  if (session == null || ctx.account == null) {
    throw new NotAuthenticatedError();
  }
  if (!validateUuid(accountId)) throw new InvalidInputError("accountId");
  if (session.accountId !== accountId) throw new NotAuthorizedError();
  const account = await ctx.db.query.accountTable.findFirst({
    where: { id: accountId },
    with: { actor: true },
  });
  if (account?.actor == null) throw new InvalidInputError("accountId");
  return account;
}

async function setAccountMigrationAliases(
  ctx: UserContext,
  accountId: Uuid,
  aliases: string[],
) {
  const rows = await ctx.db.update(actorTable)
    .set({ aliases, updated: sql`CURRENT_TIMESTAMP` })
    .where(eq(actorTable.accountId, accountId))
    .returning();
  const actor = rows[0];
  if (actor == null) throw new InvalidInputError("accountId");
  await sendAccountActorUpdate(ctx.fedCtx, accountId, actor.updated);
  const account = await ctx.db.query.accountTable.findFirst({
    where: { id: accountId },
  });
  if (account == null) throw new InvalidInputError("accountId");
  return account;
}

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
    name: t.field({
      type: "String",
      description:
        "The account holder's display name.  Empty when the account is " +
        "permanently suspended (banned) and the viewer is neither the " +
        "account holder nor a moderator (mirrors the redacted `Actor`).",
      select: {
        columns: { name: true },
        with: { actor: sanctionActorRelation },
      },
      resolve: (account, _, ctx) =>
        account.actor != null && isActorProfileHidden(account.actor, ctx)
          ? ""
          : account.name,
    }),
    bio: t.field({
      type: "Markdown",
      description:
        "The account holder's profile bio in Markdown.  Empty when the " +
        "account is permanently suspended (banned) and the viewer is " +
        "neither the account holder nor a moderator.",
      select: {
        columns: { bio: true },
        with: { actor: sanctionActorRelation },
      },
      resolve: (account, _, ctx) =>
        account.actor != null && isActorProfileHidden(account.actor, ctx)
          ? ""
          : account.bio,
    }),
    avatarMediumId: t.field({
      type: "UUID",
      nullable: true,
      description:
        "UUID of the medium used as this account's avatar.  `null` when " +
        "the account is permanently suspended (banned) and the viewer is " +
        "neither the account holder nor a moderator, so the real avatar " +
        "medium cannot be resolved through `node(id:)`.",
      select: {
        columns: { avatarMediumId: true },
        with: { actor: sanctionActorRelation },
      },
      resolve: (account, _, ctx) =>
        account.actor != null && isActorProfileHidden(account.actor, ctx)
          ? null
          : account.avatarMediumId,
    }),
    avatarUrl: t.field({
      type: "URL",
      deprecationReason: "Use avatarMediumId instead.",
      select: {
        columns: {
          avatarMediumId: true,
        },
        with: {
          actor: sanctionActorRelation,
          avatarMedium: true,
          emails: true,
        },
      },
      async resolve(account, _, ctx) {
        if (
          account.actor != null && isActorProfileHidden(account.actor, ctx)
        ) {
          return new URL("https://gravatar.com/avatar/?d=mp&s=128");
        }
        const url = await getAvatarUrl(ctx.disk, account);
        return new URL(url);
      },
    }),
    ogImageUrl: t.field({
      type: "URL",
      description:
        "URL of the generated Open Graph image for this account's profile " +
        "page. Generated on first request and cached; high-complexity " +
        "operation (avoid requesting in bulk).  For a permanently " +
        "suspended (banned) account, viewers other than the account " +
        "holder and moderators get an image built from redacted profile " +
        "content (no display name, bio, or avatar), and the cached key is " +
        "not overwritten.",
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
              id: true,
              suspended: true,
              suspendedUntil: true,
            },
          },
          emails: true,
        },
      },
      async resolve(account, _, ctx) {
        const hidden = account.actor != null &&
          isActorProfileHidden(account.actor, ctx);
        const handle = `@${account.username}@${account.actor.handleHost}`;
        if (hidden) {
          // Build the OG image from redacted content; do not persist the
          // redacted key so the real one survives the ban.
          const placeholder = "https://gravatar.com/avatar/?d=mp&s=128";
          const key = await putProfileOgImage(ctx.disk, null, {
            avatarKey: placeholder,
            avatarUrl: placeholder,
            bio: "",
            displayName: "",
            handle,
          });
          return new URL(await ctx.disk.getUrl(key));
        }
        const avatarUrl = await getAvatarUrl(ctx.disk, account);
        const bio = await renderMarkup(ctx.fedCtx, account.bio, {
          kv: ctx.kv,
        });
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
    moderator: t.exposeBoolean("moderator", {
      description:
        "Whether this account has moderator privileges. Moderators can view " +
        "`postCount` and `lastPostPublished` for any account, and perform " +
        "administrative mutations such as `deleteOrphanMedia` and " +
        "`regenerateInvitations`.",
    }),
    invitationsLeft: t.exposeInt("leftInvitations", {
      description:
        "Number of invitation slots this account can still hand out. " +
        "Only visible to the account holder and to moderators.",
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
    hideFromInvitationTree: t.exposeBoolean("hideFromInvitationTree", {
      authScopes: (parent) => ({
        moderator: true,
        selfAccount: parent.id,
      }),
      description:
        "Whether this account has opted out of the public invitation tree. " +
        "When `true`, the account appears anonymously in the invitation tree " +
        "and its invitation relationships are hidden on profiles (see " +
        "`Account.inviter`). Only visible to the account holder and " +
        "moderators; change it with the `hideFromInvitationTree` input of " +
        "the `updateAccount` mutation.",
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
    defaultQuotePolicy: t.field({
      type: QuotePolicy,
      description:
        "The quote policy applied to new notes when the user does not " +
        "choose one explicitly at creation time.",
      select: {
        columns: { quotePolicy: true },
      },
      resolve(account) {
        return toQuotePolicy(account.quotePolicy);
      },
    }),
    pushNotificationPreviewPolicy: t.field({
      type: PushNotificationPreviewPolicy,
      authScopes: (parent) => ({
        moderator: true,
        selfAccount: parent.id,
      }),
      description:
        "Controls whether push notification payloads may include short post " +
        "content previews. Only visible to the account holder and moderators.",
      select: {
        columns: { pushNotificationPreviewPolicy: true },
      },
      resolve(account) {
        return toPushNotificationPreviewPolicy(
          account.pushNotificationPreviewPolicy,
        );
      },
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    created: t.expose("created", { type: "DateTime" }),
    actor: t.relation("actor", {
      type: Actor,
      description:
        "The public ActivityPub identity for this account. All public " +
        "data — name, bio, posts, followers — lives on the `Actor`. " +
        "Use this to access fields that are visible to everyone.",
    }),
    links: t.field({
      type: [AccountLink],
      description:
        "Profile links displayed on the account's public page, ordered " +
        "by their display index. Links with a non-null `verified` timestamp " +
        "have passed rel-me verification.  Empty when the account is " +
        "permanently suspended (banned) and the viewer is neither the " +
        "account holder nor a moderator, mirroring the suspended " +
        "ActivityPub actor stub.",
      select: {
        with: {
          actor: {
            columns: { id: true, suspended: true, suspendedUntil: true },
          },
          links: { orderBy: { index: "asc" } },
        },
      },
      resolve: (account, _, ctx) =>
        account.actor != null && isActorProfileHidden(account.actor, ctx)
          ? []
          : account.links,
    }),
    notifications: t.connection({
      type: Notification,
      description:
        "This account's notifications, newest first. Only visible to " +
        "the account holder. Notifications whose actor list is empty " +
        "(e.g., the actor was deleted) are automatically excluded.",
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
    description:
      "Shareable invitation links created by this account, newest first. " +
      "Only visible to the account holder and moderators.",
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
    query: {
      orderBy: { created: "desc", id: "desc" },
    },
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

// Defined via `drizzleObjectField` rather than inline in the `Account`
// `fields` block because the field's type (`Account`) is the very node being
// defined; referencing it inside its own initializer would make TypeScript
// infer `Account` as `any`.
builder.drizzleObjectField(Account, "inviter", (t) =>
  t.field({
    type: Account,
    nullable: true,
    description:
      "The account that invited this account to sign up. `null` for " +
      "accounts created before the invitation system was introduced and " +
      "for the instance's founding accounts. Honors the " +
      "`hideFromInvitationTree` privacy setting: returns `null` when either " +
      "this account or its inviter has opted out of the invitation tree, " +
      "unless the viewer is the account itself, that account's inviter, or " +
      "a moderator (all of whom always see the real inviter).",
    select: (_args, _ctx, nestedSelection) => ({
      columns: { inviterId: true, hideFromInvitationTree: true },
      with: { inviter: selectAccountWithHideFlag(nestedSelection) },
    }),
    resolve(account, _args, ctx) {
      const inviter = account.inviter;
      if (inviter == null) return null;
      const viewer = ctx.account;
      const bypass = viewer != null &&
        (viewer.id === account.id ||
          viewer.id === account.inviterId ||
          viewer.moderator);
      if (
        !bypass &&
        (account.hideFromInvitationTree || inviter.hideFromInvitationTree)
      ) {
        return null;
      }
      return inviter;
    },
  }));

builder.drizzleObjectField(Account, "invitees", (t) =>
  t.connection(
    {
      type: Account,
      description:
        "Accounts that were invited by this account, newest first. " +
        "The `totalCount` on this connection reflects all invitees ever, " +
        "not just those visible to the current viewer.",
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
      description:
        "Unpublished article drafts belonging to this account, most " +
        "recently updated first. Only visible to the account holder.",
      authScopes: (parent) => ({
        selfAccount: "id" in parent ? parent.id : undefined,
      }),
      query: () => ({
        orderBy: { updated: "desc" },
      }),
    }),
);

// Per-request batching loader for Account.postCount and
// Account.lastPostPublished.  Without this, requesting these fields on a
// 50-row connection would fan out to 100 separate aggregate queries.
export function getAdminAccountStats(
  ctx: UserContext,
  accountId: Uuid,
): Promise<AdminAccountStats> {
  ctx.adminAccountStatsLoader ??= new DataLoader<Uuid, AdminAccountStats>(
    async (ids) => {
      const idList = ids as Uuid[];
      const rows = await ctx.db
        .select({
          accountId: actorTable.accountId,
          postCount: sql<number>`COUNT(*)::int`,
          lastPublished: sql<Date | null>`MAX(${postTable.published})`,
        })
        .from(postTable)
        .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
        .where(
          and(
            isNotNull(actorTable.accountId),
            inArray(actorTable.accountId, idList),
          ),
        )
        .groupBy(actorTable.accountId);
      const map = new Map<string, AdminAccountStats>();
      for (const row of rows) {
        if (row.accountId == null) continue;
        const raw = row.lastPublished;
        const lastPostPublished = raw == null
          ? null
          : raw instanceof Date
          ? raw
          : new Date(raw as unknown as string);
        map.set(row.accountId, {
          postCount: Number(row.postCount),
          lastPostPublished,
        });
      }
      return idList.map((id) =>
        map.get(id) ?? { postCount: 0, lastPostPublished: null }
      );
    },
    // Per-request memoisation is on (the loader instance lives on
    // UserContext, so its cache only spans one request).  None of the
    // mutations exposed by this stack mutate postTable, so two reads
    // of the same account.id within one request never observe a
    // changed value; if a post-mutating mutation is added later this
    // loader will need its cache cleared after the mutation runs.
    { cache: true },
  );
  return ctx.adminAccountStatsLoader.load(accountId);
}

// TODO: Move postCount/lastPostPublished to a proper connection-based
// field like `Account.posts.totalCount` so that these aggregates follow
// the same pagination pattern as other counts on the `Actor` type.
builder.drizzleObjectField(Account, "postCount", (t) =>
  t.int({
    nullable: true,
    description:
      "The total number of posts authored by this account.  Visible to " +
      "the account holder and moderators; `null` otherwise.",
    authScopes: (parent) => ({
      moderator: true,
      selfAccount: parent.id,
    }),
    async resolve(account, _, ctx) {
      const stats = await getAdminAccountStats(ctx, account.id);
      return stats.postCount;
    },
  }));

builder.drizzleObjectField(Account, "lastPostPublished", (t) =>
  t.field({
    type: "DateTime",
    nullable: true,
    description:
      "The latest `published` timestamp across all posts authored by " +
      "this account, or `null` when there are no posts.  Visible to the " +
      "account holder and moderators.",
    authScopes: (parent) => ({
      moderator: true,
      selfAccount: parent.id,
    }),
    async resolve(account, _, ctx) {
      const stats = await getAdminAccountStats(ctx, account.id);
      return stats.lastPostPublished;
    },
  }));

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
  description:
    "A profile link on a local account's public page.  Not resolvable via " +
    "`node(id:)` when the owning account is permanently suspended (banned) " +
    "and the viewer is neither the account holder nor a moderator.",
  authScopes: async (link, ctx) => {
    const account = await ctx.db.query.accountTable.findFirst({
      where: { id: link.accountId },
      with: {
        actor: {
          columns: { id: true, suspended: true, suspendedUntil: true },
        },
      },
    });
    if (account?.actor != null && isActorProfileHidden(account.actor, ctx)) {
      return false;
    }
    return true;
  },
  // Run the scope when the node itself is resolved, so a cached or
  // constructed link node id cannot bypass the Account.links redaction.
  runScopesOnType: true,
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
    description:
      "The `Account` of the currently authenticated user, or `null` " +
      "when not authenticated. Use this as the entry point for all " +
      "viewer-specific data (notifications, drafts, settings).",
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
    description:
      "Look up a local account by its username (without the `@host` " +
      "suffix). Returns `null` when no account with that username exists.",
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
    description: "All local accounts. Intended for internal tooling; prefer " +
      "`adminAccounts` for paginated moderator views.",
    resolve(query, _, __, ctx) {
      return ctx.db.query.accountTable.findMany(query());
    },
  }),
}));

interface InvitationTreeNode {
  id: string;
  username: string | null;
  name: string | null;
  handle: string | null;
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
    handle: t.exposeString("handle", {
      description:
        "Full fediverse handle in `@username@host` format, or `null` when " +
        "the account has opted out of the invitation tree.",
      nullable: true,
    }),
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
      "Returns all accounts as a flat array for building the invitation tree. " +
      "Nodes are ordered oldest-to-newest by account creation time so that sibling ordering is stable across views.",
    async resolve(_, __, ctx) {
      const accounts = await ctx.db.query.accountTable.findMany({
        with: {
          actor: true,
          avatarMedium: true,
          emails: true,
        },
      });

      const sorted = [...accounts].sort(
        (a, b) => +a.created - +b.created || a.id.localeCompare(b.id),
      );

      return await Promise.all(
        sorted.map(async (account) => {
          // Anonymize a node when its holder opted out OR when the account is
          // profile-hidden (a banned local account), so a ban redacts the
          // name/handle/avatar here too; the holder and moderators still see
          // the real values (isActorProfileHidden honors the viewer).
          const hidden = account.hideFromInvitationTree ||
            (account.actor != null && isActorProfileHidden(account.actor, ctx));
          return {
            id: account.id,
            username: hidden ? null : account.username,
            name: hidden ? null : account.name,
            handle: hidden ? null : account.actor.handle,
            avatarUrl: hidden
              ? DEFAULT_AVATAR_URL
              : await getAvatarUrl(ctx.disk, account),
            inviterId: account.inviterId,
            hidden,
          };
        }),
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
    description:
      "Update the authenticated viewer's account settings. Only the " +
      "account holder may update their own account.",
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
      defaultQuotePolicy: t.field({
        type: QuotePolicy,
        description:
          "New default quote policy for notes. Ignored and stored as " +
          "`SELF` when the effective `defaultNoteVisibility` is " +
          "`FOLLOWERS`, `DIRECT`, or `NONE` (whether set in this request " +
          "or already stored on the account).",
      }),
      pushNotificationPreviewPolicy: t.field({
        type: PushNotificationPreviewPolicy,
        description: "New policy for including post content previews in push " +
          "notification payloads.",
      }),
      links: t.field({
        type: [AccountLinkInput],
      }),
    }),
  },
  {
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw createGraphQLError("Not authenticated.", {
          extensions: { code: "UNAUTHENTICATED" },
        });
      } else if (session.accountId !== args.input.id.id) {
        throw createGraphQLError("Not authorized.", {
          extensions: { code: "FORBIDDEN" },
        });
      }
      const account = await ctx.db.query.accountTable.findFirst({
        where: {
          id: args.input.id.id,
        },
      });
      if (account == null) {
        throw createGraphQLError("Account not found.", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      if (args.input.username != null && account.usernameChanged != null) {
        throw createGraphQLError(
          "Username cannot be changed after it has been changed.",
          { extensions: { code: "BAD_USER_INPUT" } },
        );
      }
      if (
        args.input.username != null &&
        args.input.username !== account.username &&
        await isUsernameReserved(ctx.db, args.input.username)
      ) {
        throw createGraphQLError("Username is already taken.", {
          extensions: { code: "BAD_USER_INPUT" },
        });
      }
      let avatarMediumId: Uuid | undefined;
      if (args.input.avatarUrl != null) {
        if (args.input.avatarMediumId != null) {
          throw createGraphQLError(
            "avatarUrl and avatarMediumId are mutually exclusive.",
            { extensions: { code: "BAD_USER_INPUT" } },
          );
        }
        const medium = await createAvatarMediumFromUrl(
          ctx.db,
          ctx.disk,
          args.input.avatarUrl,
          { userAgentUrl: new URL(ctx.fedCtx.canonicalOrigin) },
        );
        if (medium == null) {
          throw createGraphQLError("Avatar URL must point to an image.", {
            extensions: { code: "BAD_USER_INPUT" },
          });
        }
        avatarMediumId = medium.id;
      } else if (args.input.avatarMediumId != null) {
        const medium = await ctx.db.query.mediumTable.findFirst({
          where: { id: args.input.avatarMediumId },
        });
        if (medium == null) {
          throw createGraphQLError("Medium not found.", {
            extensions: { code: "NOT_FOUND" },
          });
        }
        const avatarMedium = await createAvatarMediumFromMedium(
          ctx.db,
          ctx.disk,
          medium,
        );
        if (avatarMedium == null) {
          throw createGraphQLError("Avatar medium must point to an image.", {
            extensions: { code: "BAD_USER_INPUT" },
          });
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
          quotePolicy: (() => {
            const effectiveNoteVis = args.input.defaultNoteVisibility != null
              ? fromPostVisibility(args.input.defaultNoteVisibility)
              : account.noteVisibility;
            if (
              effectiveNoteVis === "followers" ||
              effectiveNoteVis === "direct" ||
              effectiveNoteVis === "none"
            ) return "self";
            return args.input.defaultQuotePolicy == null
              ? undefined
              : fromQuotePolicy(args.input.defaultQuotePolicy);
          })(),
          pushNotificationPreviewPolicy:
            args.input.pushNotificationPreviewPolicy == null
              ? undefined
              : fromPushNotificationPreviewPolicy(
                args.input.pushNotificationPreviewPolicy,
              ),
          links: args.input.links ?? undefined,
        },
      );
      if (result == null) {
        throw createGraphQLError("Failed to update account.", {
          originalError: new Error("Failed to update account."),
          extensions: { code: "INTERNAL_SERVER_ERROR" },
        });
      }
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

builder.relayMutationField(
  "addAccountMigrationAlias",
  {
    description:
      "Add a previous account actor as an ActivityPub migration alias for " +
      "the authenticated viewer's local account. The stored value is the " +
      "resolved actor IRI, which is then advertised as `alsoKnownAs` on " +
      "the local actor document so a later remote `Move` can be validated.",
    inputFields: (t) => ({
      accountId: t.globalID({
        for: Account,
        required: true,
        description:
          "The `Account` global id owned by the authenticated viewer. " +
          "Passing another account id returns `NotAuthorizedError`.",
      }),
      actor: t.string({
        required: true,
        description:
          "Previous account to import from, written as `@user@host`, " +
          "`user@host`, or an HTTP(S) actor/profile URL. The value is " +
          "resolved before storage so aliases always contain actor IRIs.",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const account = await getAuthorizedMigrationAccount(
        ctx,
        args.input.accountId.id,
      );
      const oldActor = await lookupMigrationAliasActor(ctx, args.input.actor);
      if (
        oldActor == null ||
        oldActor.id === account.actor.id ||
        oldActor.accountId === account.id
      ) {
        throw new InvalidInputError("actor");
      }
      const aliases = account.actor.aliases.includes(oldActor.iri)
        ? account.actor.aliases
        : [...account.actor.aliases, oldActor.iri];
      return await setAccountMigrationAliases(ctx, account.id, aliases);
    },
  },
  {
    outputFields: (t) => ({
      account: t.field({
        type: Account,
        description:
          "The updated local account. Read `Account.actor.aliases` for " +
          "the canonical set of previous actor IRIs now advertised as " +
          "`alsoKnownAs`.",
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "removeAccountMigrationAlias",
  {
    description:
      "Remove one ActivityPub migration alias from the authenticated " +
      "viewer's local account. Removing an alias only changes the new " +
      "account's `alsoKnownAs` list; it does not send or retract a remote " +
      "`Move` activity.",
    inputFields: (t) => ({
      accountId: t.globalID({
        for: Account,
        required: true,
        description:
          "The `Account` global id owned by the authenticated viewer. " +
          "Passing another account id returns `NotAuthorizedError`.",
      }),
      alias: t.field({
        type: "URL",
        required: true,
        description: "The exact previous actor IRI to remove from " +
          "`Account.actor.aliases`. Missing aliases are accepted so " +
          "clients can retry safely.",
      }),
    }),
  },
  {
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    async resolve(_root, args, ctx) {
      const account = await getAuthorizedMigrationAccount(
        ctx,
        args.input.accountId.id,
      );
      const alias = args.input.alias.href;
      const aliases = account.actor.aliases.filter((a) => a !== alias);
      return await setAccountMigrationAliases(ctx, account.id, aliases);
    },
  },
  {
    outputFields: (t) => ({
      account: t.field({
        type: Account,
        description:
          "The updated local account. Read `Account.actor.aliases` for " +
          "the canonical set of previous actor IRIs now advertised as " +
          "`alsoKnownAs`.",
        resolve(result) {
          return result;
        },
      }),
    }),
  },
);

builder.relayMutationField(
  "deleteAccount",
  {
    description:
      "Permanently delete the authenticated viewer's account. This " +
      "hard-deletes the local account data, reserves the account's current " +
      "`username`, commits the deleted actor's tombstone and preserved keys, " +
      "then attempts to enqueue one actor-level ActivityPub `Delete` to " +
      "followers. A transient delivery queue failure is logged after commit " +
      "and does not resurrect the account. Session-store cleanup is also " +
      "best-effort after the deletion commits.",
    inputFields: (t) => ({
      id: t.globalID({
        for: Account,
        required: true,
        description:
          "The `Account` global id of the authenticated viewer. Passing any " +
          "other account id returns `NotAuthorizedError`.",
      }),
    }),
  },
  {
    errors: {
      types: [
        NotAuthenticatedError,
        NotAuthorizedError,
        InvalidInputError,
        AccountDeletionUnavailableError,
      ],
    },
    async resolve(_root, args, ctx) {
      const session = await ctx.session;
      if (session == null || ctx.account == null) {
        throw new NotAuthenticatedError();
      }
      if (session.accountId !== args.input.id.id) {
        throw new NotAuthorizedError();
      }
      const result = await deleteAccountModel(ctx.fedCtx, args.input.id.id);
      if (result == null) throw new InvalidInputError("id");
      try {
        await deleteSession(ctx.kv, session.id);
      } catch (error) {
        logger.warn(
          "Failed to delete session after deleting account {accountId}: {error}",
          {
            accountId: result.accountId,
            error,
          },
        );
      }
      return result;
    },
  },
  {
    outputFields: (t) => ({
      deletedAccountId: t.id({
        description:
          "The global `Account` id that was deleted. Clients can use this " +
          "to evict viewer/account records after the mutation succeeds.",
        resolve: (result) => encodeGlobalID("Account", result.accountId),
      }),
      username: t.exposeString("username", {
        description:
          "The deleted account's current `username`, which is now reserved " +
          "and cannot be reused by signup or rename flows.",
      }),
      deleted: t.expose("deleted", {
        type: "DateTime",
        description: "When the account was deleted.",
      }),
    }),
  },
);
