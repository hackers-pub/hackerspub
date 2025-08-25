import {
  getRegistrationOptions,
  verifyRegistration,
} from "@hackerspub/models/passkey";
import { passkeyTable } from "@hackerspub/models/schema";
import {
  encodeGlobalID,
  resolveCursorConnection,
  type ResolveCursorConnectionArgs,
} from "@pothos/plugin-relay";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";

export const Passkey = builder.drizzleNode("passkeyTable", {
  name: "Passkey",
  id: {
    column: (passkey) => passkey.id,
  },
  fields: (t) => ({
    name: t.exposeString("name"),
    lastUsed: t.expose("lastUsed", { type: "DateTime", nullable: true }),
    created: t.expose("created", { type: "DateTime" }),
  }),
});

const PasskeyRegistrationResult = builder
  .objectRef<{
    verified: boolean;
    passkey: typeof Passkey.$inferType | null;
  }>("PasskeyRegistrationResult")
  .implement({
    fields: (t) => ({
      verified: t.exposeBoolean("verified"),
      passkey: t.field({
        type: Passkey,
        nullable: true,
        resolve: (parent) => parent.passkey,
      }),
    }),
  });

// Add passkeys connection to Account type
builder.objectField(Account, "passkeys", (t) =>
  t.connection({
    type: Passkey,
    authScopes: (parent) => ({
      selfAccount: parent.id,
    }),
    async resolve(account, args, ctx) {
      return resolveCursorConnection(
        {
          args,
          toCursor: (passkey) => passkey.created.valueOf().toString(),
        },
        async (
          { before, after, limit, inverted }: ResolveCursorConnectionArgs,
        ) => {
          const beforeDate = before ? new Date(Number(before)) : undefined;
          const afterDate = after ? new Date(Number(after)) : undefined;

          return await ctx.db
            .select()
            .from(passkeyTable)
            .where(
              and(
                eq(passkeyTable.accountId, account.id),
                before
                  ? inverted
                    ? lt(passkeyTable.created, beforeDate!)
                    : gt(passkeyTable.created, beforeDate!)
                  : undefined,
                after
                  ? inverted
                    ? gt(passkeyTable.created, afterDate!)
                    : lt(passkeyTable.created, afterDate!)
                  : undefined,
              ),
            )
            .orderBy(
              inverted ? passkeyTable.created : desc(passkeyTable.created),
            ).limit(limit);
        },
      );
    },
  }));

builder.mutationFields((t) => ({
  getPasskeyRegistrationOptions: t.field({
    type: "JSON",
    args: {
      accountId: t.arg.globalID({ for: Account, required: true }),
    },
    async resolve(_, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new Error("Not authenticated.");
      if (session.accountId !== args.accountId.id) {
        throw new Error("Not authorized.");
      }
      const account = await ctx.db.query.accountTable.findFirst({
        where: { id: args.accountId.id },
        with: { passkeys: true },
      });
      if (account == null) throw new Error("Account not found.");
      const options = await getRegistrationOptions(
        ctx.kv,
        ctx.fedCtx.canonicalOrigin,
        account,
      );
      return options;
    },
  }),
  verifyPasskeyRegistration: t.field({
    type: PasskeyRegistrationResult,
    args: {
      accountId: t.arg.globalID({ for: Account, required: true }),
      name: t.arg.string({ required: true }),
      registrationResponse: t.arg({ type: "JSON", required: true }),
    },
    async resolve(_, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new Error("Not authenticated.");
      if (session.accountId !== args.accountId.id) {
        throw new Error("Not authorized.");
      }
      const account = await ctx.db.query.accountTable.findFirst({
        where: { id: args.accountId.id },
        with: { passkeys: true },
      });
      if (account == null) throw new Error("Account not found.");
      const result = await verifyRegistration(
        ctx.db,
        ctx.kv,
        ctx.fedCtx.canonicalOrigin,
        account,
        args.name,
        args.registrationResponse as RegistrationResponseJSON,
      );

      let passkey = null;
      if (result.verified && result.registrationInfo != null) {
        // Fetch the newly created passkey
        passkey = await ctx.db.query.passkeyTable.findFirst({
          where: {
            id: result.registrationInfo.credential.id,
          },
        });
      }

      return {
        verified: result.verified,
        passkey: passkey || null,
      };
    },
  }),
  revokePasskey: t.field({
    type: "ID",
    nullable: true,
    args: {
      passkeyId: t.arg.globalID({ for: Passkey, required: true }),
    },
    async resolve(_, args, ctx) {
      const session = await ctx.session;
      if (session == null) throw new Error("Not authenticated.");
      const passkey = await ctx.db.query.passkeyTable.findFirst({
        where: { id: args.passkeyId.id },
      });
      if (passkey == null) return null;
      if (passkey.accountId !== session.accountId) {
        throw new Error("Not authorized.");
      }
      await ctx.db.delete(passkeyTable).where(
        eq(passkeyTable.id, args.passkeyId.id),
      );
      return encodeGlobalID(Passkey.name, args.passkeyId.id);
    },
  }),
}));
