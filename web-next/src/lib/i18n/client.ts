import type { Messages } from "@lingui/core";

export async function loadMessages(locale: string) {
  const { messages } = await import(`~/locales/${locale}/messages.po`);
  return messages as Messages;
}
