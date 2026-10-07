import {
  AccountSecurityError,
  SECURITY_ACTIONS,
  SECURITY_ERRORS,
  changeAccountSecurity,
  getSecurityAuthenticationOptions,
  type SecurityAction,
  type SecurityProof,
} from "@hackerspub/models/account-security";
import {
  accountRecoveryCodeTable,
  type Account as AccountRow,
} from "@hackerspub/models/schema";
import { createSession, type Session } from "@hackerspub/models/session";
import { queueAfterCommit, withTransaction } from "@hackerspub/models/tx";
import { getLogger } from "@logtape/logtape";
import { and, count, eq, isNull } from "drizzle-orm";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { PasskeyPlatform } from "@hackerspub/models/passkey";
import { Account } from "./account.ts";
import { getAccountSecurityMessage } from "./account-security-message.ts";
import { builder, type UserContext } from "./builder.ts";
import { NotAuthenticatedError, SessionRef } from "./session.ts";

const logger = getLogger(["hackerspub", "graphql", "account-security"]);
const descriptions: Record<SecurityAction, string> = {
  ENABLE: "Disable email sign-in and issue the first recovery-code set.",
  DISABLE: "Restore email sign-in using a registered passkey.",
  REGENERATE:
    "Replace all unused recovery codes with ten newly generated codes.",
  REGISTER: "Authorize adding a passkey while email sign-in is disabled.",
  REVOKE: "Authorize removing a passkey while retaining at least one.",
};
const actionType = builder.enumType("AccountSecurityAction", {
  description:
    "Purpose of a fresh WebAuthn assertion. A proof cannot be reused for another action or session.",
  values: Object.fromEntries(
    SECURITY_ACTIONS.map((action) => [
      action,
      { value: action, description: descriptions[action] },
    ]),
  ),
});
const errorDescriptions = {
  PASSKEY_REQUIRED:
    "Register at least one passkey before disabling email sign-in.",
  INVALID_ASSERTION:
    "The assertion or registration authorization is invalid, expired, consumed, or bound to another session, purpose, or security generation.",
  NOT_FOUND:
    "The authenticated personal account or current session is unavailable.",
  ALREADY_ENABLED:
    "Email sign-in is already disabled; regenerate recovery codes instead.",
  NOT_ENABLED:
    "Email sign-in is enabled, so this strict-mode operation is unavailable.",
};
const errorType = builder.enumType("AccountSecurityErrorCode", {
  description: "Expected security-setting failures, localized by clients.",
  values: Object.fromEntries(
    SECURITY_ERRORS.map((code) => [
      code,
      { value: code, description: errorDescriptions[code] },
    ]),
  ),
});
builder.objectType(AccountSecurityError, {
  name: "AccountSecurityError",
  description:
    "An expected failure changing the authenticated account's security settings. No setting change occurred.",
  fields: (t) => ({
    code: t.field({
      type: errorType,
      description:
        "The reason the requested security operation could not complete.",
      resolve: (error) => error.code,
    }),
  }),
});
const optionsType = builder
  .objectRef<Awaited<ReturnType<typeof getSecurityAuthenticationOptions>>>(
    "AccountSecurityAuthenticationOptions",
  )
  .implement({
    description:
      "A session-bound WebAuthn challenge for exactly one security action, expiring after five minutes.",
    fields: (t) => ({
      challengeId: t.expose("challengeId", {
        type: "UUID",
        description:
          "Pass this identifier to the requested security mutation; it cannot be used with `loginByPasskey`.",
      }),
      options: t.expose("options", {
        type: "JSON",
        description:
          "WebAuthn request options requiring user verification and an existing account credential.",
      }),
    }),
  });
function authenticated(ctx: UserContext): Session {
  if (
    ctx.account == null ||
    ctx.session == null ||
    ctx.session.accountId !== ctx.account.id
  )
    throw new NotAuthenticatedError();
  return ctx.session;
}
builder.drizzleObjectFields(Account, (t) => ({
  emailLoginEnabled: t.boolean({
    nullable: true,
    description:
      "Whether verified email addresses can authenticate this account. `null` for non-owners and organizations; notifications still use email when this is `false`.",
    resolve: (account, _, ctx) =>
      account.kind === "personal" && ctx.session?.accountId === account.id
        ? account.emailLoginEnabled
        : null,
  }),
  recoveryCodeCount: t.int({
    nullable: true,
    description:
      "Number of unused one-time recovery codes (at most ten). `null` for non-owners and organizations; plaintext codes are never queryable.",
    async resolve(account, _, ctx) {
      if (account.kind !== "personal" || ctx.session?.accountId !== account.id)
        return null;
      const [row] = await ctx.db
        .select({ count: count() })
        .from(accountRecoveryCodeTable)
        .where(
          and(
            eq(accountRecoveryCodeTable.accountId, account.id),
            isNull(accountRecoveryCodeTable.used),
          ),
        );
      return row.count;
    },
  }),
}));
builder.mutationField("getAccountSecurityAuthenticationOptions", (t) =>
  t.field({
    type: optionsType,
    description:
      "Prepare an assertion for one security operation on the signed-in personal account. Existing keys and user verification are required; a recent login alone never authorizes a security change.",
    errors: {
      types: [NotAuthenticatedError, AccountSecurityError],
      union: {
        description:
          "A purpose-bound challenge or an authentication or account-security failure.",
      },
    },
    args: {
      action: t.arg({
        type: actionType,
        required: true,
        description:
          "The operation this assertion may authorize, once, on the current session.",
      }),
    },
    resolve: (_, args, ctx) =>
      getSecurityAuthenticationOptions(
        ctx.db,
        ctx.kv,
        ctx.fedCtx.canonicalOrigin,
        authenticated(ctx),
        args.action as SecurityAction,
      ),
  }),
);

interface SecurityChangeResult {
  account: AccountRow;
  recoveryCodes: string[];
  session?: Session;
}
async function change(
  ctx: UserContext,
  action: "ENABLE" | "DISABLE" | "REGENERATE",
  proof: SecurityProof,
  locale: Intl.Locale,
): Promise<SecurityChangeResult> {
  const session = authenticated(ctx);
  return await withTransaction(ctx.fedCtx, async (fedCtx) => {
    const result: SecurityChangeResult = await changeAccountSecurity(
      fedCtx.db,
      ctx.kv,
      ctx.fedCtx.canonicalOrigin,
      session,
      action,
      proof,
    );
    if (action === "ENABLE") {
      const remoteAddr = ctx.connectionInfo?.remoteAddr;
      result.session = await createSession(ctx.kv, {
        accountId: session.accountId,
        authenticationMethod: "passkey",
        userAgent: ctx.request.headers.get("User-Agent"),
        ipAddress:
          remoteAddr?.transport === "tcp" ? remoteAddr.hostname : undefined,
      });
    }
    const emails = await fedCtx.db.query.accountEmailTable.findMany({
      where: { accountId: session.accountId, verified: { isNotNull: true } },
    });
    await queueAfterCommit(fedCtx, async () => {
      for (const email of emails) {
        try {
          const receipt = await ctx.email.send(
            await getAccountSecurityMessage({
              from: ctx.emailFrom,
              to: email.email,
              locale,
              username: result.account.username,
              kind: action,
            }),
          );
          if (!receipt.successful)
            logger.error(
              "Security notice delivery failed for {accountId} ({action})",
              { accountId: session.accountId, action },
            );
        } catch {
          logger.error(
            "Security notice delivery failed for {accountId} ({action})",
            { accountId: session.accountId, action },
          );
        }
      }
    });
    return result;
  });
}
for (const [name, action] of [
  ["enableAccountPasskeyOnly", "ENABLE"],
  ["disableAccountPasskeyOnly", "DISABLE"],
  ["regenerateAccountRecoveryCodes", "REGENERATE"],
] as const) {
  builder.relayMutationField(
    name,
    {
      description: `Input for \`${name}\`, including a fresh purpose-bound passkey assertion.`,
      inputFields: (t) => ({
        challengeId: t.field({
          type: "UUID",
          required: true,
          description:
            "Identifier from `getAccountSecurityAuthenticationOptions` for this operation and session.",
        }),
        authenticationResponse: t.field({
          type: "JSON",
          required: true,
          description:
            "The authenticator's signed assertion with user verification.",
        }),
        platform: t.string({
          defaultValue: "web",
          description:
            "Passkey client platform: `web`, `android`, or `ios`; determines accepted origins.",
        }),
        locale: t.field({
          type: "Locale",
          required: true,
          description:
            "Preferred language for the security-change email notice.",
        }),
      }),
    },
    {
      description:
        action === "ENABLE"
          ? "Disable email sign-in after a fresh existing-passkey assertion. Issues ten recovery codes shown only in this response, invalidates old email links and email or legacy sessions, and returns a replacement passkey session. Save the codes before leaving."
          : action === "DISABLE"
            ? "Restore verified-email sign-in after a fresh passkey assertion. Deletes remaining recovery codes and pending recovery registration grants; previously revoked sessions and links stay invalid."
            : "Replace all recovery codes after a fresh passkey assertion. The ten plaintext codes appear only in this response; previous codes and pending recovery registration grants are invalidated. Email sign-in stays disabled.",
      errors: {
        types: [NotAuthenticatedError, AccountSecurityError],
        union: {
          description:
            "A successful security-change payload or an authentication or security-setting error.",
        },
      },
      resolve: (_, args, ctx) =>
        change(
          ctx,
          action,
          {
            challengeId: args.input.challengeId,
            authenticationResponse: args.input
              .authenticationResponse as AuthenticationResponseJSON,
            platform: args.input.platform as PasskeyPlatform,
          },
          args.input.locale,
        ),
    },
    {
      description:
        "The committed security setting, plus credentials available only in this response when applicable.",
      outputFields: (t) => ({
        account: t.field({
          type: Account,
          description:
            "Updated account; select its private security fields to update the client.",
          resolve: (result) => result.account,
        }),
        ...(action === "ENABLE"
          ? {
              session: t.field({
                type: SessionRef,
                description:
                  "Replacement passkey session. Replace the client's current cookie or bearer token before further requests.",
                resolve: (result) => result.session!,
              }),
            }
          : {}),
        ...(action !== "DISABLE"
          ? {
              recoveryCodes: t.stringList({
                description:
                  "Exactly ten one-time codes, each with 128 bits of entropy. Save offline; do not normalize these into a client cache or telemetry. This plaintext cannot be retrieved later.",
                resolve: (result) => result.recoveryCodes,
              }),
            }
          : {}),
      }),
    },
  );
}
