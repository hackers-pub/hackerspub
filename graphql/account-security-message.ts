import { negotiateLocale } from "@hackerspub/models/i18n";
import { createMessage, type Message } from "@upyo/core";
import { escape } from "es-toolkit";
import { readFile } from "node:fs/promises";

export async function getAccountSecurityMessage(options: {
  from: string;
  to: string;
  locale: Intl.Locale;
  username: string;
  kind: "emailLoginDisabled" | "ENABLE" | "DISABLE" | "REGENERATE";
}): Promise<Message> {
  const locale =
    negotiateLocale(options.locale, ["en", "ja", "ko", "zh-CN", "zh-TW"])
      ?.baseName ?? "en";
  const data = JSON.parse(
    await readFile(
      new URL(`./locales/${locale}.json`, import.meta.url),
      "utf8",
    ),
  );
  const template = data.accountSecurity[options.kind] as {
    emailSubject: string;
    emailContent: string;
  };
  const substitute = (text: string) =>
    text.replaceAll("{{username}}", options.username);
  const text = substitute(template.emailContent);
  return createMessage({
    from: options.from,
    to: options.to,
    subject: substitute(template.emailSubject),
    content: { text, html: escape(text).replaceAll("\n", "<br>\n") },
  });
}
