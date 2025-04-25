import { builder } from "./builder.ts";

const Account = builder.drizzleNode("accountTable", {
  name: "Account",
  id: {
    column: (account) => account.id,
  },
  fields: (t) => ({
    username: t.exposeString("username"),
    oldUsername: t.exposeString("oldUsername", { nullable: true }),
    name: t.exposeString("name"),
  }),
});

builder.queryFields((t) => ({
  account: t.drizzleField({
    type: Account,
    authScopes: {
      moderator: true,
    },
    args: {
      id: t.arg.globalID({ required: true, for: Account }),
    },
    nullable: true,
    resolve: (query, _, { id }, ctx) => {
      return ctx.drizzle.query.accountTable.findFirst(
        query({ where: { id: id.id.id } }),
      );
    },
  }),
}));
