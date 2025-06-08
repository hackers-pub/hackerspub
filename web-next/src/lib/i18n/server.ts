import type { Messages } from "@lingui/core";

const locales = import.meta.glob("~/locales/*/messages.po");
const messagesMap = Object.fromEntries(
  (
    await Promise.all(
      Object.entries(locales).map(async ([path, load]) => {
        const locale = path.match(/\/([^/]+)\/messages\.po$/)?.[1];
        if (!locale) return;
        const { messages } = (await load()) as { messages: Messages };
        return [locale, messages] as const;
      }),
    )
  ).filter((v) => v != null),
);

export async function loadMessages(locale: string) {
  const messages = messagesMap[locale];
  if (!messages) throw new Error(`Unknown locale: ${locale}`);
  return messages;
}
