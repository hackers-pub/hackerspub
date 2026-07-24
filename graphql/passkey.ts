import {
  getRegistrationOptions,
  type PasskeyPlatform,
  resolvePasskeyOrigins,
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
import { createGraphQLError } from "graphql-yoga";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";

export const Passkey = builder.drizzleNode("passkeyTable", {
  name: "Passkey",
  description:
    "A WebAuthn passkey registered to an account. Passkeys can be used " +
    "to authenticate via `loginByPasskey` without a password or email code.",
  id: {
    column: (passkey) => passkey.id,
  },
  fields: (t) => ({
    name: t.exposeString("name", {
      description:
        'User-provided label for this passkey (e.g., "MacBook Touch ID"). ' +
        "Set at registration time via `verifyPasskeyRegistration`.",
    }),
    lastUsed: t.expose("lastUsed", {
      type: "DateTime",
      nullable: true,
      description:
        "`null` if this passkey has never been used to authenticate.",
    }),
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
        async ({
          before,
          after,
          limit,
          inverted,
        }: ResolveCursorConnectionArgs) => {
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
            )
            .limit(limit);
        },
      );
    },
  }),
);

builder.mutationFields((t) => ({
  getPasskeyRegistrationOptions: t.field({
    type: "JSON",
    description:
      "Generate WebAuthn registration options for adding a new passkey. " +
      "Pass a fresh `sessionId` UUID, then send the authenticator's " +
      "response to `verifyPasskeyRegistration`. Requires authentication.",
    args: {
      accountId: t.arg.globalID({ for: Account, required: true }),
    },
    async resolve(_, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw createGraphQLError("Not authenticated.", {
          extensions: { code: "UNAUTHENTICATED" },
        });
      }
      if (session.accountId !== args.accountId.id) {
        throw createGraphQLError("Not authorized.", {
          extensions: { code: "FORBIDDEN" },
        });
      }
      const account = await ctx.db.query.accountTable.findFirst({
        where: { id: args.accountId.id },
        with: { passkeys: true },
      });
      if (account == null) {
        throw createGraphQLError("Account not found.", {
          extensions: { code: "NOT_FOUND" },
        });
      }
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
    description:
      "Complete passkey registration by verifying the authenticator " +
      "response from `getPasskeyRegistrationOptions`. On success, the " +
      "new `Passkey` is returned. Requires authentication.",
    args: {
      accountId: t.arg.globalID({ for: Account, required: true }),
      name: t.arg.string({ required: true }),
      registrationResponse: t.arg({ type: "JSON", required: true }),
      platform: t.arg.string({ required: false, defaultValue: "web" }),
    },
    async resolve(_, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw createGraphQLError("Not authenticated.", {
          extensions: { code: "UNAUTHENTICATED" },
        });
      }
      if (session.accountId !== args.accountId.id) {
        throw createGraphQLError("Not authorized.", {
          extensions: { code: "FORBIDDEN" },
        });
      }
      const account = await ctx.db.query.accountTable.findFirst({
        where: { id: args.accountId.id },
        with: { passkeys: true },
      });
      if (account == null) {
        throw createGraphQLError("Account not found.", {
          extensions: { code: "NOT_FOUND" },
        });
      }
      const origins = resolvePasskeyOrigins(
        ctx.fedCtx.canonicalOrigin,
        (args.platform ?? "web") as PasskeyPlatform,
      );
      const rpId = new URL(ctx.fedCtx.canonicalOrigin).hostname;
      const result = await verifyRegistration(
        ctx.db,
        ctx.kv,
        origins,
        rpId,
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
    description:
      "Delete a passkey from the account. Returns the deleted passkey's " +
      "global ID, or `null` if the passkey was not found. Requires " +
      "authentication and ownership of the passkey.",
    args: {
      passkeyId: t.arg.globalID({ for: Passkey, required: true }),
    },
    async resolve(_, args, ctx) {
      const session = await ctx.session;
      if (session == null) {
        throw createGraphQLError("Not authenticated.", {
          extensions: { code: "UNAUTHENTICATED" },
        });
      }
      const passkey = await ctx.db.query.passkeyTable.findFirst({
        where: { id: args.passkeyId.id },
      });
      if (passkey == null) return null;
      if (passkey.accountId !== session.accountId) {
        throw createGraphQLError("Not authorized.", {
          extensions: { code: "FORBIDDEN" },
        });
      }
      await ctx.db
        .delete(passkeyTable)
        .where(eq(passkeyTable.id, args.passkeyId.id));
      return encodeGlobalID(Passkey.name, args.passkeyId.id);
    },
  }),
}));
