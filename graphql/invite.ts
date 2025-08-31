import { normalizeEmail } from "@hackerspub/models/account";
import { negotiateLocale } from "@hackerspub/models/i18n";
import {
  type Account as AccountTable,
  accountTable,
  type Actor,
} from "@hackerspub/models/schema";
import { createSignupToken, type SignupToken } from "@hackerspub/models/signup";
import type { Uuid } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { expandGlob } from "@std/fs";
import { join } from "@std/path";
import { createMessage, type Message } from "@upyo/core";
import { and, eq, gt, sql } from "drizzle-orm";
import { parseTemplate } from "url-template";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";
import { EMAIL_FROM } from "./email.ts";

const logger = getLogger(["hackerspub", "graphql", "invite"]);

interface Invitation {
  inviterId: Uuid;
  email: string;
  locale: Intl.Locale;
  message?: string;
}

const InvitationRef = builder.objectRef<Invitation>("Invitation");

InvitationRef.implement({
  description: "An invitation that has been created.",
  fields: (t) => ({
    inviter: t.field({
      type: Account,
      async resolve(invitation, _, ctx) {
        const account = await ctx.db.query.accountTable.findFirst({
          where: { id: invitation.inviterId },
          with: { actor: true },
        });
        if (account == null) {
          throw new Error(
            `Account with ID ${invitation.inviterId} not found.`,
          );
        }
        return account;
      },
    }),
    email: t.field({
      type: "Email",
      resolve(invitation) {
        return invitation.email;
      },
    }),
    locale: t.field({
      type: "Locale",
      resolve(invitation) {
        return invitation.locale;
      },
    }),
    message: t.field({
      type: "Markdown",
      nullable: true,
      resolve(invitation) {
        return invitation.message ?? null;
      },
    }),
  }),
});

const InviteInviterError = builder.enumType("InviteInviterError", {
  values: ["INVITER_NOT_AUTHENTICATED", "INVITER_NO_INVITATIONS_LEFT"] as const,
});

const InviteEmailError = builder.enumType("InviteEmailError", {
  values: ["EMAIL_INVALID", "EMAIL_ALREADY_TAKEN"] as const,
});

const InviteVerifyUrlError = builder.enumType("InviteVerifyUrlError", {
  values: ["VERIFY_URL_NO_TOKEN", "VERIFY_URL_NO_CODE"] as const,
});

interface InviteValidationErrors {
  inviter?: typeof InviteInviterError.$inferType;
  email?: typeof InviteEmailError.$inferType;
  verifyUrl?: typeof InviteVerifyUrlError.$inferType;
  emailOwnerId?: Uuid;
}

const InviteValidationErrorsRef = builder.objectRef<InviteValidationErrors>(
  "InviteValidationErrors",
);

InviteValidationErrorsRef.implement({
  description: "Validation errors that occurred during the invitation process.",
  fields: (t) => ({
    inviter: t.field({
      type: InviteInviterError,
      nullable: true,
      resolve: (errors) => errors.inviter ?? null,
    }),
    email: t.field({
      type: InviteEmailError,
      nullable: true,
      resolve: (errors) => errors.email ?? null,
    }),
    verifyUrl: t.field({
      type: InviteVerifyUrlError,
      nullable: true,
      resolve: (errors) => errors.verifyUrl ?? null,
    }),
    emailOwner: t.field({
      type: Account,
      nullable: true,
      resolve(errors, _, ctx) {
        if (errors.emailOwnerId == null) return null;
        return ctx.db.query.accountTable.findFirst({
          where: { id: errors.emailOwnerId },
        });
      },
    }),
  }),
});

const InviteResultRef = builder.unionType("InviteResult", {
  types: [InvitationRef, InviteValidationErrorsRef],
  resolveType(obj) {
    if ("inviterId" in obj) return InvitationRef;
    return InviteValidationErrorsRef;
  },
});

export const EXPIRATION = Temporal.Duration.from({ hours: 48 });

builder.mutationField("invite", (t) =>
  t.field({
    type: InviteResultRef,
    args: {
      email: t.arg({ type: "Email", required: true }),
      locale: t.arg({ type: "Locale", required: true }),
      message: t.arg({ type: "Markdown" }),
      verifyUrl: t.arg({
        type: "URITemplate",
        required: true,
        description:
          "The RFC 6570-compliant URI Template for the verification link.  Available variables: `{token}` and `{code}`.",
      }),
    },
    async resolve(_root, args, ctx) {
      const errors = {} as InviteValidationErrors;
      if (ctx.account == null) errors.inviter = "INVITER_NOT_AUTHENTICATED";
      else if (ctx.account.leftInvitations < 1) {
        errors.inviter = "INVITER_NO_INVITATIONS_LEFT";
      }
      let email: string | undefined;
      try {
        email = normalizeEmail(args.email);
      } catch {
        errors.email = "EMAIL_INVALID";
      }
      if (email != null) {
        const existingEmail = await ctx.db.query.accountEmailTable.findFirst({
          where: { email },
        });
        if (existingEmail != null) {
          errors.email = "EMAIL_ALREADY_TAKEN";
          errors.emailOwnerId = existingEmail.accountId;
        }
      }
      const verifyUrlTemplate = parseTemplate(args.verifyUrl);
      const a = verifyUrlTemplate.expand({
        token: "00000000-0000-0000-0000-000000000000",
        code: "AAAAAA",
      });
      const b = verifyUrlTemplate.expand({
        token: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        code: "AAAAAA",
      });
      if (a === b) {
        errors.verifyUrl = "VERIFY_URL_NO_TOKEN";
      }
      const c = verifyUrlTemplate.expand({
        token: "00000000-0000-0000-0000-000000000000",
        code: "BBBBBB",
      });
      if (a === c) {
        errors.verifyUrl = "VERIFY_URL_NO_CODE";
      }
      if (
        errors.inviter != null || errors.email != null ||
        errors.email != null || ctx.account == null || email == null
      ) {
        return errors;
      }
      const updated = await ctx.db.update(accountTable).set({
        leftInvitations: sql`${accountTable.leftInvitations} - 1`,
      }).where(
        and(
          eq(accountTable.id, ctx.account.id),
          gt(accountTable.leftInvitations, 0),
        ),
      ).returning();
      if (updated.length < 1) {
        return {
          inviter: "INVITER_NO_INVITATIONS_LEFT",
        } satisfies InviteValidationErrors;
      }
      const token = await createSignupToken(ctx.kv, email, {
        inviterId: ctx.account.id,
        expiration: EXPIRATION,
      });
      const message = await getEmailMessage({
        locale: args.locale,
        inviter: ctx.account,
        verifyUrlTemplate: args.verifyUrl,
        to: email,
        token,
        message: args.message ?? undefined,
      });
      const receipt = await ctx.email.send(message);
      if (!receipt.successful) {
        logger.error(
          "Failed to send invitation email: {errors}",
          { errors: receipt.errorMessages },
        );
      }
      return {
        inviterId: ctx.account.id,
        email,
        locale: args.locale,
        message: args.message ?? undefined,
      };
    },
  }));

const LOCALES_DIR = join(import.meta.dirname!, "locales");

async function getEmailTemplate(
  locale: Intl.Locale,
  message: boolean,
): Promise<{ subject: string; content: string }> {
  const availableLocales: Record<string, string> = {};
  const files = expandGlob(join(LOCALES_DIR, "*.json"), {
    includeDirs: false,
  });
  for await (const file of files) {
    if (!file.isFile) continue;
    const match = file.name.match(/^(.+)\.json$/);
    if (match == null) continue;
    const localeName = match[1];
    availableLocales[localeName] = file.path;
  }
  const selectedLocale =
    negotiateLocale(locale, Object.keys(availableLocales)) ??
      new Intl.Locale("en");
  const path = availableLocales[selectedLocale.baseName];
  const json = await Deno.readTextFile(path);
  const data = JSON.parse(json);
  return {
    subject: data.invite.emailSubject,
    content: message
      ? data.invite.emailContentWithMessage
      : data.invite.emailContent,
  };
}

async function getEmailMessage(
  { locale, inviter, to, verifyUrlTemplate, token, message }: {
    locale: Intl.Locale;
    inviter: AccountTable & { actor: Actor };
    to: string;
    verifyUrlTemplate: string;
    token: SignupToken;
    message?: string;
  },
): Promise<Message> {
  const verifyUrl = parseTemplate(verifyUrlTemplate).expand({
    token: token.token,
    code: token.code,
  });
  const expiration = EXPIRATION.toLocaleString(locale.baseName, {
    // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
    style: "long",
  });
  const template = await getEmailTemplate(locale, message != null);
  function substitute(template: string): string {
    return template.replaceAll(
      /\{\{(verifyUrl|code|expiration|inviter|inviterName|message)\}\}/g,
      (m) => {
        return m === "{{verifyUrl}}"
          ? verifyUrl
          : m === "{{code}}"
          ? token.code
          : m === "{{expiration}}"
          ? expiration
          : m === "{{inviter}}"
          ? `${inviter.name} (${inviter.actor.handle})`
          : m === "{{inviterName}}"
          ? inviter.name
          : (message ?? "");
      },
    );
  }
  return createMessage({
    from: EMAIL_FROM,
    to,
    subject: substitute(template.subject),
    content: {
      text: substitute(template.content),
    },
  });
}
