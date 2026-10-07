import {
  AccountSecurityError,
  consumeRecoveryRegistrationGrant,
  lockSecurityAccount,
  verifySecurityAssertion,
} from "@hackerspub/models/account-security";
import { runInTransaction } from "@hackerspub/models/db";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
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
      "Options are bound to the authenticated session for five minutes. Send the authenticator's " +
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
        session.id,
      );
      return options;
    },
  }),
  verifyPasskeyRegistration: t.field({
    type: PasskeyRegistrationResult,
    description:
      "Complete passkey registration by verifying the authenticator " +
      "response from `getPasskeyRegistrationOptions`. On success, the " +
      "new `Passkey` is returned. Requires authentication. Passkey-only accounts also require exactly one fresh `REGISTER` assertion or a session-bound recovery grant; invalid proof fails with `INVALID_ASSERTION`.",
    args: {
      accountId: t.arg.globalID({ for: Account, required: true }),
      name: t.arg.string({
        required: true,
        description:
          "A label that distinguishes this passkey from the account's other " +
          "passkeys. Surrounding whitespace is trimmed, and a blank name is " +
          "rejected with a `BAD_USER_INPUT` error.",
      }),
      registrationResponse: t.arg({ type: "JSON", required: true }),
      securityChallengeId: t.arg({
        type: "UUID",
        description:
          "Purpose `REGISTER` challenge for this session; required with `securityAuthenticationResponse` in passkey-only mode unless a recovery grant is provided.",
      }),
      securityAuthenticationResponse: t.arg({
        type: "JSON",
        description:
          "Fresh existing-key assertion for `REGISTER`. Must accompany `securityChallengeId` and cannot be combined with a recovery grant.",
      }),
      recoveryRegistrationToken: t.arg.string({
        description:
          "One-time ten-minute grant from `loginByRecoveryCode`, accepted only with its recovery session. Cannot be combined with assertion arguments.",
      }),
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
      const name = args.name.trim();
      if (name === "") {
        throw createGraphQLError("Passkey name must not be blank.", {
          extensions: { code: "BAD_USER_INPUT" },
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
      const result = await runInTransaction(ctx.db, async (tx) => {
        const current = await lockSecurityAccount(tx, session);
        try {
          const assertion =
            args.securityChallengeId != null ||
            args.securityAuthenticationResponse != null;
          const recovery = args.recoveryRegistrationToken != null;
          if (
            (assertion && recovery) ||
            (assertion &&
              (args.securityChallengeId == null ||
                args.securityAuthenticationResponse == null))
          )
            throw new AccountSecurityError("INVALID_ASSERTION");
          if (recovery)
            await consumeRecoveryRegistrationGrant(
              ctx.kv,
              current,
              session,
              args.recoveryRegistrationToken!,
            );
          else if (!current.emailLoginEnabled || assertion)
            await verifySecurityAssertion(
              tx,
              ctx.kv,
              ctx.fedCtx.canonicalOrigin,
              current,
              session,
              "REGISTER",
              args.securityChallengeId == null
                ? undefined
                : {
                    challengeId: args.securityChallengeId,
                    authenticationResponse:
                      args.securityAuthenticationResponse as AuthenticationResponseJSON,
                    platform: (args.platform ?? "web") as PasskeyPlatform,
                  },
            );
        } catch (error) {
          if (error instanceof AccountSecurityError)
            throw createGraphQLError(
              "Passkey registration requires a fresh assertion or recovery registration grant.",
              { extensions: { code: error.code } },
            );
          throw error;
        }
        return await verifyRegistration(
          tx,
          ctx.kv,
          origins,
          rpId,
          current,
          name,
          args.registrationResponse as RegistrationResponseJSON,
          session.id,
        );
      });

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
      "authentication and ownership of the passkey. When email sign-in is disabled, a fresh `REVOKE` assertion is required and removing the last key fails with `LAST_PASSKEY`.",
    args: {
      passkeyId: t.arg.globalID({ for: Passkey, required: true }),
      securityChallengeId: t.arg({
        type: "UUID",
        description:
          "Purpose `REVOKE` challenge for this session, required in passkey-only mode.",
      }),
      securityAuthenticationResponse: t.arg({
        type: "JSON",
        description:
          "Fresh assertion from an existing passkey for `REVOKE`, paired with `securityChallengeId`.",
      }),
      platform: t.arg.string({
        defaultValue: "web",
        description:
          "Passkey client platform: `web`, `android`, or `ios`; determines accepted origins.",
      }),
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
      return await runInTransaction(ctx.db, async (tx) => {
        const current = await lockSecurityAccount(tx, session);
        const keys = await tx
          .select()
          .from(passkeyTable)
          .where(eq(passkeyTable.accountId, session.accountId));
        if (!keys.some((key) => key.id === args.passkeyId.id)) return null;
        if (!current.emailLoginEnabled && keys.length <= 1)
          throw createGraphQLError(
            "The last passkey cannot be revoked while email sign-in is disabled.",
            { extensions: { code: "LAST_PASSKEY" } },
          );
        if (!current.emailLoginEnabled) {
          try {
            await verifySecurityAssertion(
              tx,
              ctx.kv,
              ctx.fedCtx.canonicalOrigin,
              current,
              session,
              "REVOKE",
              args.securityChallengeId == null ||
                args.securityAuthenticationResponse == null
                ? undefined
                : {
                    challengeId: args.securityChallengeId,
                    authenticationResponse:
                      args.securityAuthenticationResponse as AuthenticationResponseJSON,
                    platform: args.platform as PasskeyPlatform,
                  },
            );
          } catch (error) {
            if (error instanceof AccountSecurityError)
              throw createGraphQLError(
                "Passkey revocation requires a fresh assertion.",
                { extensions: { code: error.code } },
              );
            throw error;
          }
        }
        await tx
          .delete(passkeyTable)
          .where(eq(passkeyTable.id, args.passkeyId.id));
        return encodeGlobalID(Passkey.name, args.passkeyId.id);
      });
    },
  }),
}));
