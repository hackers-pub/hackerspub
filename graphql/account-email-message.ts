import { negotiateLocale } from "@hackerspub/models/i18n";
import { createMessage, type Message } from "@upyo/core";
import { escape } from "es-toolkit";
import { readFile } from "node:fs/promises";

interface EmailTemplate {
  emailSubject: string;
  emailContent: string;
}
const templates = new Map<
  string,
  Promise<
    Record<"accountEmailVerification" | "accountEmailChange", EmailTemplate>
  >
>();

export async function getAccountEmailMessage(options: {
  from: string;
  to: string;
  locale: Intl.Locale;
  username: string;
  kind: "verification" | "change";
  code?: string;
}): Promise<Message> {
  const locale =
    negotiateLocale(options.locale, ["en", "ja", "ko", "zh-CN", "zh-TW"])
      ?.baseName ?? "en";
  let promise = templates.get(locale);
  if (promise == null) {
    promise = readFile(
      new URL(`./locales/${locale}.json`, import.meta.url),
      "utf8",
    ).then(JSON.parse);
    void promise.catch(() => templates.delete(locale));
    templates.set(locale, promise);
  }
  const data = await promise;
  const template =
    data[
      options.kind === "verification"
        ? "accountEmailVerification"
        : "accountEmailChange"
    ];
  const substitute = (text: string) =>
    text.replaceAll(/\{\{(username|code)\}\}/g, (_, key: string) =>
      key === "username" ? options.username : (options.code ?? ""),
    );
  const text = substitute(template.emailContent);
  return createMessage({
    from: options.from,
    to: options.to,
    subject: substitute(template.emailSubject),
    content: { text, html: escape(text).replaceAll("\n", "<br>\n") },
  });
}
