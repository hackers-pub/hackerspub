import { getAvatarUrl, updateAccount } from "@hackerspub/models/account";
import { Actor } from "./actor.ts";
import { builder } from "./builder.ts";

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
        with: {
          emails: true,
        },
      },
      async resolve(account, _, ctx) {
        const url = await getAvatarUrl(ctx.disk, account);
        return new URL(url);
      },
    }),
    locales: t.expose("locales", { type: ["Locale"] }),
    moderator: t.exposeBoolean("moderator"),
    leftInvitations: t.exposeInt("leftInvitations", {
      authScopes: (parent) => ({
        moderator: true,
        selfAccount: parent.id,
      }),
    }),
    updated: t.expose("updated", { type: "DateTime" }),
    created: t.expose("created", { type: "DateTime" }),
    actor: t.relation("actor", { type: Actor }),
    links: t.relation("links", { type: AccountLink }),
    inviter: t.relation("inviter", { nullable: true }),
    invitees: t.relatedConnection("invitees"),
  }),
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
      resolve(link) {
        return new URL(link.url);
      },
    }),
    handle: t.exposeString("handle", { nullable: true }),
    icon: t.exposeString("icon"),
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

builder.relayMutationField(
  "updateAccount",
  {
    inputFields: (t) => ({
      id: t.globalID({ for: Account, required: true }),
      username: t.string(),
      name: t.string(),
      bio: t.string(),
      locales: t.field({ type: ["Locale"] }),
      hideFromInvitationTree: t.boolean(),
      hideForeignLanguages: t.boolean(),
      preferAiSummary: t.boolean(),
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
      const result = await updateAccount(
        ctx.fedCtx,
        {
          id: args.input.id.id,
          username: args.input.username ?? undefined,
          name: args.input.name ?? undefined,
          bio: args.input.bio ?? undefined,
          locales: args.input.locales ?? undefined,
          hideFromInvitationTree: args.input.hideFromInvitationTree ??
            undefined,
          hideForeignLanguages: args.input.hideForeignLanguages ?? undefined,
          preferAiSummary: args.input.preferAiSummary ?? undefined,
          links: args.input.links ?? undefined,
        },
      );
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
