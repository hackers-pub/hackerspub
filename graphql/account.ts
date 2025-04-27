import { getAvatarUrl } from "@hackerspub/models/account";
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
    name: t.exposeString("name"),
    bio: t.expose("bio", { type: "Markdown" }),
    avatarUrl: t.field({
      type: "URL",
      async resolve(account, _, ctx) {
        const emails = await ctx.db.query.accountEmailTable.findMany({
          where: { accountId: account.id },
        });
        const url = await getAvatarUrl(ctx.disk, { ...account, emails });
        return new URL(url);
      },
    }),
    locales: t.exposeStringList("locales", { nullable: true }),
    moderator: t.exposeBoolean("moderator"),
    leftInvitations: t.exposeInt("leftInvitations"),
    updated: t.expose("updated", { type: "DateTime" }),
    created: t.expose("created", { type: "DateTime" }),
    actor: t.relation("actor", { type: Actor }),
    inviter: t.relation("inviter"),
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
