import { getAvatarUrl } from "@hackerspub/models/account";
import { Actor } from "./actor.ts";
import { builder } from "./builder.ts";

export const Account = builder.drizzleNode("accountTable", {
  name: "Account",
  id: {
    column: (account) => account.id,
  },
  grantScopes: async (account, ctx) =>
    [
      account.id === (await ctx.session)?.accountId && "self",
    ].filter((v) => v !== false),
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    username: t.exposeString("username"),
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
    locales: t.exposeStringList("locales", { nullable: true }),
    moderator: t.exposeBoolean("moderator"),
    leftInvitations: t.exposeInt("leftInvitations", {
      authScopes: {
        $granted: "self",
        moderator: true,
      },
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
  accountByUsername: t.drizzleField({
    type: Account,
    // authScopes: {
    //   moderator: true,
    // },
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
