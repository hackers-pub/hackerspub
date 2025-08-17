import type { Session } from "@hackerspub/models/session";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";

export class NotAuthenticatedError extends Error {
  public constructor() {
    super("Not authenticated");
  }
}

builder.objectType(NotAuthenticatedError, {
  name: "NotAuthenticatedError",
  fields: (t) => ({
    notAuthenticated: t.string({
      resolve: () => "",
    }),
  }),
});

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
        if (!account) {
          throw new Error(`Account with ID ${session.accountId} not found.`);
        }
        return account;
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
