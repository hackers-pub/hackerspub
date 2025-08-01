import { negotiateLocale } from "@hackerspub/models/i18n";
import {
  createSession,
  deleteSession,
  getSession,
  type Session,
} from "@hackerspub/models/session";
import {
  createSigninToken,
  deleteSigninToken,
  EXPIRATION,
  getSigninToken,
  type SigninToken,
} from "@hackerspub/models/signin";
import type { Uuid } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { expandGlob } from "@std/fs";
import { join } from "@std/path";
import { createMessage, type Message } from "@upyo/core";
import { sql } from "drizzle-orm";
import { parseTemplate } from "url-template";
import { Account } from "./account.ts";
import { builder } from "./builder.ts";
import { EMAIL_FROM } from "./email.ts";

const logger = getLogger(["hackerspub", "graphql", "login"]);

interface LoginChallenge {
  accountId: Uuid;
  token: Uuid;
  created: Date;
}

const LoginChallengeRef = builder.objectRef<LoginChallenge>("LoginChallenge");

LoginChallengeRef.implement({
  description: "A login challenge for an account.",
  fields: (t) => ({
    token: t.expose("token", { type: "UUID" }),
    created: t.expose("created", { type: "DateTime" }),
    account: t.field({
      type: Account,
      async resolve(challenge, _, ctx) {
        const account = await ctx.db.query.accountTable.findFirst({
          where: { id: challenge.accountId },
          with: { actor: true },
        });
        return account!;
      },
    }),
  }),
});

const SessionRef = builder.objectRef<Session>("Session");

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

builder.mutationFields((t) => ({
  loginByUsername: t.field({
    type: LoginChallengeRef,
    nullable: true,
    args: {
      username: t.arg.string({
        required: true,
        description: "The username of the account to sign in.",
      }),
      locale: t.arg({
        type: "Locale",
        required: true,
        description: "The locale for the sign-in email.",
      }),
      verifyUrl: t.arg({
        type: "URITemplate",
        required: true,
        description:
          "The RFC 6570-compliant URI Template for the verification link.  Available variabvles: `{token}` and `{code}`.",
      }),
    },
    async resolve(_, args, ctx) {
      const account = await ctx.db.query.accountTable.findFirst({
        columns: {
          id: true,
        },
        with: { emails: true },
        where: { username: args.username },
      });
      if (account == null) return null;
      const token = await createSigninToken(ctx.kv, account.id);
      const messages: Message[] = [];
      for (const { email } of account.emails) {
        const message = await getEmailMessage({
          locale: args.locale,
          to: email,
          verifyUrlTemplate: args.verifyUrl,
          token,
        });
        messages.push(message);
      }
      for await (const receipt of ctx.email.sendMany(messages)) {
        if (!receipt.successful) {
          logger.error(
            "Failed to send a login email: {errors}",
            { errors: receipt.errorMessages },
          );
        }
      }
      return {
        accountId: token.accountId,
        token: token.token,
        created: token.created,
      };
    },
  }),

  loginByEmail: t.field({
    type: LoginChallengeRef,
    nullable: true,
    args: {
      email: t.arg.string({
        required: true,
        description: "The email of the account to sign in.",
      }),
      locale: t.arg({
        type: "Locale",
        required: true,
        description: "The locale for the sign-in email.",
      }),
      verifyUrl: t.arg({
        type: "URITemplate",
        required: true,
        description:
          "The RFC 6570-compliant URI Template for the verification link.  Available variabvles: `{token}` and `{code}`.",
      }),
    },
    async resolve(_, args, ctx) {
      let account = await ctx.db.query.accountTable.findFirst({
        columns: {
          id: true,
        },
        with: { emails: true },
        where: {
          emails: { email: args.email },
        },
      });
      if (account == null) {
        account = await ctx.db.query.accountTable.findFirst({
          where: {
            emails: {
              RAW(t) {
                return sql`lower(${t.email}) = lower(${args.email})`;
              },
            },
          },
          with: { emails: true },
        });
      }
      if (account == null) return null;
      const token = await createSigninToken(ctx.kv, account.id);
      const messages: Message[] = [];
      for (const { email } of account.emails) {
        const message = await getEmailMessage({
          locale: args.locale,
          to: email,
          verifyUrlTemplate: args.verifyUrl,
          token,
        });
        messages.push(message);
      }
      for await (const receipt of ctx.email.sendMany(messages)) {
        if (!receipt.successful) {
          logger.error(
            "Failed to send a login email: {errors}",
            { errors: receipt.errorMessages },
          );
        }
      }
      return {
        accountId: token.accountId,
        token: token.token,
        created: token.created,
      };
    },
  }),

  completeLoginChallenge: t.field({
    type: SessionRef,
    nullable: true,
    args: {
      token: t.arg({
        type: "UUID",
        required: true,
        description: "The token of the login challenge.",
      }),
      code: t.arg.string({
        required: true,
        description: "The code of the login challenge.",
      }),
    },
    async resolve(_, args, ctx) {
      const token = await getSigninToken(ctx.kv, args.token);
      if (token == null || token.code !== args.code) return null;
      const remoteAddr = ctx.connectionInfo?.remoteAddr;
      await deleteSigninToken(ctx.kv, token.token);
      return await createSession(ctx.kv, {
        accountId: token.accountId,
        ipAddress: remoteAddr?.transport === "tcp"
          ? remoteAddr.hostname
          : undefined,
        userAgent: ctx.request.headers.get("User-Agent"),
      });
    },
  }),

  revokeSession: t.field({
    description: "Revoke a session by its ID.",
    type: SessionRef,
    nullable: true,
    args: {
      sessionId: t.arg({
        type: "UUID",
        required: true,
        description: "The ID of the session to log out.",
      }),
    },
    async resolve(_, args, ctx) {
      const currentSession = await ctx.session;
      if (currentSession == null) return null;
      const session = await getSession(ctx.kv, args.sessionId);
      if (session?.accountId !== currentSession.accountId) return null;
      else if (await deleteSession(ctx.kv, args.sessionId)) return session;
      return null;
    },
  }),
}));

const LOCALES_DIR = join(import.meta.dirname!, "locales");

async function getEmailTemplate(
  locale: Intl.Locale,
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
    subject: data.login.emailSubject,
    content: data.login.emailContent,
  };
}

async function getEmailMessage({ locale, to, verifyUrlTemplate, token }: {
  locale: Intl.Locale;
  to: string;
  verifyUrlTemplate: string;
  token: SigninToken;
}): Promise<Message> {
  const verifyUrl = parseTemplate(verifyUrlTemplate).expand({
    token: token.token,
    code: token.code,
  });
  const expiration = EXPIRATION.toLocaleString(locale.baseName, {
    // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
    style: "long",
  });
  const template = await getEmailTemplate(locale);
  return createMessage({
    from: EMAIL_FROM,
    to,
    subject: template.subject,
    content: {
      text: template.content
        .replaceAll(/\{\{(verifyUrl|code|expiration)\}\}/g, (m) => {
          return m === "{{verifyUrl}}"
            ? verifyUrl
            : m === "{{code}}"
            ? token.code
            : expiration;
        }),
    },
  });
}
