import type { Session } from "@hackerspub/models/session";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";

export const SessionRef = builder.objectRef<Session>("Session");

SessionRef.implement({
  description: "A login session for an account.",
  fields: (t) => ({
    id: t.expose("id", {
      type: "UUID",
      description: "The access token for the session.",
    }),
    account: t.field({
      type: Account,
      async resolve(session, _, ctx) {
        const account = await ctx.db.query.accountTable.findFirst({
          where: { id: session.accountId },
          with: { actor: true },
        });
        return account!;
      },
    }),
    userAgent: t.exposeString("userAgent", {
      description: "The user agent of the session.",
      nullable: true,
    }),
    ipAddress: t.expose("ipAddress", {
      type: "IP",
      nullable: true,
      description: "The IP address that created the session.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "The creation date of the session.",
    }),
  }),
});
