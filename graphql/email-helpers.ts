import { negotiateLocale } from "@hackerspub/models/i18n";
import type { Account as AccountTable, Actor } from "@hackerspub/models/schema";
import type { SignupToken } from "@hackerspub/models/signup";
import { expandGlob } from "@std/fs";
import { escape } from "@std/html/entities";
import { join } from "@std/path";
import { createMessage, type Message } from "@upyo/core";
import { parseTemplate } from "url-template";
import { EMAIL_FROM } from "./email.ts";

const LOCALES_DIR = join(import.meta.dirname!, "locales");

// Cache for email templates
let cachedTemplates:
  | Map<
    string,
    { subject: string; emailContent: string; emailContentWithMessage: string }
  >
  | null = null;
let cachedAvailableLocales: Record<string, string> | null = null;

async function loadEmailTemplates(): Promise<void> {
  if (cachedTemplates && cachedAvailableLocales) return;

  const availableLocales: Record<string, string> = {};
  const templates = new Map<
    string,
    { subject: string; emailContent: string; emailContentWithMessage: string }
  >();

  const files = expandGlob(join(LOCALES_DIR, "*.json"), {
    includeDirs: false,
  });

  for await (const file of files) {
    if (!file.isFile) continue;
    const match = file.name.match(/^(.+)\.json$/);
    if (match == null) continue;
    const localeName = match[1];

    try {
      const json = await Deno.readTextFile(file.path);
      const data = JSON.parse(json);
      templates.set(localeName, {
        subject: data.invite.emailSubject,
        emailContent: data.invite.emailContent,
        emailContentWithMessage: data.invite.emailContentWithMessage,
      });
      availableLocales[localeName] = file.path;
    } catch (error) {
      console.warn(
        `Failed to load email template for locale ${localeName}:`,
        error,
      );
    }
  }

  cachedTemplates = templates;
  cachedAvailableLocales = availableLocales;
}

async function getEmailTemplate(
  locale: Intl.Locale,
  message: boolean,
): Promise<{ subject: string; content: string }> {
  await loadEmailTemplates();

  const selectedLocale =
    negotiateLocale(locale, Object.keys(cachedAvailableLocales!)) ??
      new Intl.Locale("en");

  const template = cachedTemplates!.get(selectedLocale.baseName);
  if (!template) {
    throw new Error(
      `No email template found for locale ${selectedLocale.baseName}`,
    );
  }

  return {
    subject: template.subject,
    content: message ? template.emailContentWithMessage : template.emailContent,
  };
}

export async function getEmailMessage(
  { locale, inviter, to, verifyUrlTemplate, token, message, expiration }: {
    locale: Intl.Locale;
    inviter: AccountTable & { actor: Actor };
    to: string;
    verifyUrlTemplate: string;
    token: SignupToken;
    message?: string;
    expiration: Temporal.Duration;
  },
): Promise<Message> {
  const verifyUrl = parseTemplate(verifyUrlTemplate).expand({
    token: token.token,
    code: token.code,
  });
  const expirationStr = expiration.toLocaleString(locale.baseName, {
    // @ts-ignore: DurationFormatOptions, not DateTimeFormatOptions
    style: "long",
  });
  const template = await getEmailTemplate(locale, message != null);
  function substitute(template: string): string {
    return template.replaceAll(
      /\{\{(verifyUrl|code|expiration|inviter|inviterName|message)\}\}/g,
      (m) => {
        switch (m) {
          case "{{verifyUrl}}":
            return verifyUrl;
          case "{{code}}":
            return token.code;
          case "{{expiration}}":
            return expirationStr;
          case "{{inviter}}":
            return `${inviter.name} (${inviter.actor.handle})`;
          case "{{inviterName}}":
            return inviter.name;
          case "{{message}}":
            return message ?? "";
          default:
            return "";
        }
      },
    );
  }
  const textContent = substitute(template.content);
  return createMessage({
    from: EMAIL_FROM,
    to,
    subject: substitute(template.subject),
    content: {
      text: textContent,
      html: (() => {
        const parsed = URL.canParse(verifyUrl) ? new URL(verifyUrl) : null;
        if (
          parsed == null ||
          !["https:", "http:", "hackerspub:"].includes(parsed.protocol)
        ) {
          throw new Error(`Unsupported verify URL scheme: ${verifyUrl}`);
        }
        const safeVerifyUrl = parsed.toString();
        const escapedText = escape(textContent);
        const escapedUrl = escape(safeVerifyUrl);
        return escapedText
          .replaceAll(
            escapedUrl,
            `<a href="${escapedUrl}">${escapedUrl}</a>`,
          )
          .replaceAll("\n", "<br>\n");
      })(),
    },
  });
}
