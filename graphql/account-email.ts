import { getLogger } from "@logtape/logtape";
import {
  AccountEmailError,
  AccountEmailErrorCode,
  type EmailChange,
  invalidateEmailVerification,
  removeEmail,
  requestEmailVerification,
  setPrimaryEmail,
  verifyEmail,
} from "@hackerspub/models/account-email";
import { sendAccountActorUpdate } from "@hackerspub/models/account";
import { syncActorFromAccount } from "@hackerspub/models/actor";
import type { AccountEmail as AccountEmailRow } from "@hackerspub/models/schema";
import { getSessionFreshUntil, type Session } from "@hackerspub/models/session";
import { queueAfterCommit, withTransaction } from "@hackerspub/models/tx";
import { Account } from "./account.ts";
import { builder, type UserContext } from "./builder.ts";
import { getAccountEmailMessage } from "./account-email-message.ts";
import { NotAuthenticatedError } from "./session.ts";

const logger = getLogger(["hackerspub", "graphql", "account-email"]);

const codeDescriptions: Record<AccountEmailErrorCode, string> = {
  INVALID_EMAIL:
    "The address has an invalid format or exceeds the supported length.",
  UNAVAILABLE:
    "The address is unavailable for this account, including a concurrent ownership claim.",
  ALREADY_REGISTERED: "This account already has this verified address.",
  NOT_FOUND: "The requested address does not belong to this personal account.",
  UNVERIFIED:
    "Only a verified address can become the primary notification address.",
  LIMIT_REACHED:
    "The account has reached the limit of five verified email addresses.",
  RATE_LIMITED:
    "Too many verification emails were requested. Wait for `retryAfter` seconds.",
  INVALID_CODE:
    "The challenge or code is incorrect, expired, exhausted, consumed, or belongs to another session.",
  REAUTHENTICATION_REQUIRED:
    "Sign in again with an existing credential before making this change.",
  PRIMARY_EMAIL:
    "Choose another primary address before removing the current one.",
  LAST_EMAIL:
    "The last verified email address cannot be removed, even when a passkey exists.",
  DELIVERY_FAILED:
    "The verification email could not be sent. The request still counts toward sending limits.",
};
const EmailErrorCode = builder.enumType("AccountEmailErrorCode", {
  description:
    "Expected email-management failures. Clients should localize these codes rather than display server messages.",
  values: Object.fromEntries(
    Object.values(AccountEmailErrorCode).map((value) => [
      value,
      { value, description: codeDescriptions[value] },
    ]),
  ),
});
builder.objectType(AccountEmailError, {
  name: "AccountEmailError",
  description:
    "An expected failure managing the authenticated personal account's email addresses. No ownership change occurred.",
  fields: (t) => ({
    code: t.field({
      type: EmailErrorCode,
      description:
        "The reason the requested email operation could not complete.",
      resolve: (error) => error.code,
    }),
    retryAfter: t.int({
      nullable: true,
      description:
        "Seconds until another verification request is allowed; `null` unless this is a rate-limit error.",
      resolve: (error) => error.retryAfter,
    }),
  }),
});
const AccountEmail = builder.objectRef<AccountEmailRow>("AccountEmail");
AccountEmail.implement({
  description:
    "A private email credential on a personal account. Unverified legacy addresses cannot authenticate or receive notifications.",
  fields: (t) => ({
    email: t.exposeString("email", {
      description:
        "The stored address, preserving its original spelling. Visible only to its account owner.",
    }),
    primary: t.exposeBoolean("primary", {
      description:
        "Whether ordinary notification digests are sent here. The primary address must be verified.",
    }),
    verified: t.expose("verified", {
      type: "DateTime",
      nullable: true,
      description:
        "When ownership was confirmed; `null` for a legacy address awaiting verification.",
    }),
  }),
});

builder.drizzleObjectFields(Account, (t) => ({
  emails: t.field({
    type: [AccountEmail],
    nullable: true,
    description:
      "Private email credentials, visible only to this authenticated personal account's owner; `null` for other viewers and organizations. New registrations are limited to five verified addresses; existing legacy addresses remain visible.",
    async resolve(account, _, ctx) {
      if (account.kind !== "personal" || ctx.session?.accountId !== account.id)
        return null;
      return await ctx.db.query.accountEmailTable.findMany({
        where: { accountId: account.id },
        orderBy: { primary: "desc", created: "asc", email: "asc" },
      });
    },
  }),
  emailManagementAvailableUntil: t.field({
    type: "DateTime",
    nullable: true,
    description:
      "The deadline for requesting an email addition, changing the primary address, or removing an address after a recent sign-in. `null` for stale sessions, non-owners and organizations. Native clients can obtain a fresh bearer session through the existing login mutations.",
    resolve(account, _, ctx) {
      if (account.kind !== "personal" || ctx.session?.accountId !== account.id)
        return null;
      return getSessionFreshUntil(ctx.session) ?? null;
    },
  }),
}));

function authenticated(ctx: UserContext, fresh = true): Session {
  if (
    ctx.account == null ||
    ctx.session == null ||
    ctx.session.accountId !== ctx.account.id
  )
    throw new NotAuthenticatedError();
  if (ctx.account.kind !== "personal") throw new AccountEmailError("NOT_FOUND");
  if (fresh && getSessionFreshUntil(ctx.session) == null)
    throw new AccountEmailError("REAUTHENTICATION_REQUIRED");
  return ctx.session;
}

async function finishChange(
  ctx: UserContext,
  operation: (ctx: UserContext) => Promise<EmailChange | AccountEmailError>,
): Promise<EmailChange["account"]> {
  const result = await withTransaction(ctx.fedCtx, async (fedCtx) => {
    const result = await operation({ ...ctx, db: fedCtx.db, fedCtx });
    if (result instanceof AccountEmailError) return result;
    if (result.primaryChanged && result.account.avatarMediumId == null) {
      const account = await fedCtx.db.query.accountTable.findFirst({
        where: { id: result.account.id },
        with: { avatarMedium: true, emails: true, links: true },
      });
      if (account != null) {
        await syncActorFromAccount(fedCtx, account);
        await sendAccountActorUpdate(
          fedCtx,
          account.id,
          result.account.updated,
        );
      }
    }
    await queueAfterCommit(fedCtx, async () => {
      // Include removed addresses; additions notify only pre-existing owners.
      for (const email of result.previousEmails.filter(
        (email) => email.verified != null,
      )) {
        try {
          const message = await getAccountEmailMessage({
            from: ctx.emailFrom,
            to: email.email,
            locale: new Intl.Locale(result.account.locales?.[0] ?? "en"),
            username: result.account.username,
            kind: "change",
          });
          const receipt = await ctx.email.send(message);
          if (!receipt.successful)
            logger.error(
              "Email-change notice delivery failed for account {accountId}",
              { accountId: result.account.id },
            );
        } catch (error) {
          logger.error(
            "Email-change notice failed for account {accountId}: {error}",
            { accountId: result.account.id, error },
          );
        }
      }
    });
    return result;
  });
  // Throw after commit so incorrect-code attempts survive typed API errors.
  if (result instanceof AccountEmailError) throw result;
  return result.account;
}

builder.relayMutationField(
  "requestAccountEmailVerification",
  {
    description:
      "Input for `requestAccountEmailVerification` on the authenticated personal account.",
    inputFields: (t) => ({
      email: t.field({
        type: "Email",
        required: true,
        description:
          "Address whose ownership to verify. Addresses belonging to another account are unavailable.",
      }),
      locale: t.field({
        type: "Locale",
        required: true,
        description:
          "Preferred language for the verification email, with an English fallback.",
      }),
    }),
  },
  {
    description:
      "Send a verification code to a new or legacy unverified email address. Requires a personal account and a session authenticated within ten minutes; the request does not reserve the address or enable sign-in. Sending is limited per account and recipient.",
    errors: {
      types: [NotAuthenticatedError, AccountEmailError],
      union: {
        description:
          "The verification request payload or an authentication or email-management error.",
      },
    },
    async resolve(_, args, ctx) {
      const session = authenticated(ctx);
      const result = await requestEmailVerification(
        ctx.db,
        session.accountId,
        session.id,
        args.input.email,
      );
      if (result instanceof AccountEmailError) throw result;
      try {
        const message = await getAccountEmailMessage({
          from: ctx.emailFrom,
          to: result.email,
          locale: args.input.locale,
          username: ctx.account!.username,
          kind: "verification",
          code: result.code,
        });
        const receipt = await ctx.email.send(message);
        if (!receipt.successful)
          throw new Error("Verification email delivery failed.");
      } catch {
        await invalidateEmailVerification(ctx.db, result.token);
        logger.error(
          "Verification email delivery failed for account {accountId}",
          { accountId: session.accountId },
        );
        throw new AccountEmailError("DELIVERY_FAILED");
      }
      return result;
    },
  },
  {
    description:
      "A code was sent to the requested address. Enter it in the session that initiated the request.",
    outputFields: (t) => ({
      token: t.expose("token", {
        type: "UUID",
        description:
          "Opaque identifier of the session-bound verification request. The code is delivered only by email.",
      }),
      expires: t.expose("expires", {
        type: "DateTime",
        description:
          "Deadline for completing this request, fifteen minutes after issuance.",
      }),
    }),
  },
);

builder.relayMutationField(
  "verifyAccountEmail",
  {
    description:
      "Input for `verifyAccountEmail` on the authenticated personal account.",
    inputFields: (t) => ({
      token: t.field({
        type: "UUID",
        required: true,
        description:
          "Identifier returned by `requestAccountEmailVerification` in this same session.",
      }),
      code: t.string({
        required: true,
        description:
          "Eight-character verification code received at the requested address.",
      }),
    }),
  },
  {
    description:
      "Confirm the emailed code and add the verified address, or verify an existing legacy row. Requires the initiating session but does not require renewed authentication while its approved challenge is still valid. Five incorrect attempts exhaust the request.",
    errors: {
      types: [NotAuthenticatedError, AccountEmailError],
      union: {
        description:
          "The verified account payload or an authentication or verification error.",
      },
    },
    async resolve(_, args, ctx) {
      const session = authenticated(ctx, false);
      return await finishChange(ctx, (ctx) =>
        verifyEmail(
          ctx.db,
          session.accountId,
          session.id,
          args.input.token,
          args.input.code,
        ),
      );
    },
  },
  {
    description:
      "The authenticated account after a successful email ownership verification.",
    outputFields: (t) => ({
      account: t.field({
        type: Account,
        description:
          "Updated account; select `emails` to refresh the client's private list.",
        resolve: (account) => account,
      }),
    }),
  },
);

builder.relayMutationField(
  "setPrimaryAccountEmail",
  {
    description:
      "Input for `setPrimaryAccountEmail` on the authenticated personal account.",
    inputFields: (t) => ({
      email: t.field({
        type: "Email",
        required: true,
        description:
          "Verified address already belonging to the authenticated personal account.",
      }),
    }),
  },
  {
    description:
      "Choose a verified address for ordinary notification digests. Requires a personal account and authentication within ten minutes; other verified addresses remain usable for sign-in. When using Gravatar, the public avatar is synchronized from this address.",
    errors: {
      types: [NotAuthenticatedError, AccountEmailError],
      union: {
        description:
          "The updated primary address payload or an authentication or email-management error.",
      },
    },
    async resolve(_, args, ctx) {
      const session = authenticated(ctx);
      return await finishChange(ctx, (ctx) =>
        setPrimaryEmail(ctx.db, session.accountId, args.input.email),
      );
    },
  },
  {
    description:
      "The account after selecting its primary notification address.",
    outputFields: (t) => ({
      account: t.field({
        type: Account,
        description: "Updated account with the selected primary address.",
        resolve: (account) => account,
      }),
    }),
  },
);

builder.relayMutationField(
  "removeAccountEmail",
  {
    description:
      "Input for `removeAccountEmail` on the authenticated personal account.",
    inputFields: (t) => ({
      email: t.field({
        type: "Email",
        required: true,
        description:
          "Secondary address to remove. A legacy unverified address may also be removed.",
      }),
    }),
  },
  {
    description:
      "Remove a secondary address from the authenticated personal account after authentication within ten minutes. The primary and last verified addresses cannot be removed; login links issued to a removed address are invalidated. Existing signed-in sessions remain valid.",
    errors: {
      types: [NotAuthenticatedError, AccountEmailError],
      union: {
        description:
          "The removed address payload or an authentication or email-management error.",
      },
    },
    async resolve(_, args, ctx) {
      const session = authenticated(ctx);
      return await finishChange(ctx, (ctx) =>
        removeEmail(ctx.db, session.accountId, args.input.email),
      );
    },
  },
  {
    description: "The account after a secondary email credential was removed.",
    outputFields: (t) => ({
      account: t.field({
        type: Account,
        description: "Updated account without the removed credential.",
        resolve: (account) => account,
      }),
    }),
  },
);
