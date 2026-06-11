import { negotiateLocale } from "@hackerspub/models/i18n";
import type { FlagAction } from "@hackerspub/models/schema";
import { expandGlob } from "@std/fs";
import { join } from "@std/path";
import { createMessage, type Message } from "@upyo/core";
import { EMAIL_FROM } from "./email.ts";

const LOCALES_DIR = join(import.meta.dirname!, "locales");

interface ModerationTemplates {
  actionNames: Record<string, string>;
  subject: string;
  content: string;
}

let cachedTemplates: Map<string, ModerationTemplates> | null = null;

async function loadTemplates(): Promise<Map<string, ModerationTemplates>> {
  if (cachedTemplates != null) return cachedTemplates;
  const templates = new Map<string, ModerationTemplates>();
  const files = expandGlob(join(LOCALES_DIR, "*.json"), {
    includeDirs: false,
  });
  for await (const file of files) {
    if (!file.isFile) continue;
    const match = file.name.match(/^(.+)\.json$/);
    if (match == null) continue;
    try {
      const data = JSON.parse(await Deno.readTextFile(file.path));
      if (data.moderation == null) continue;
      templates.set(match[1], {
        actionNames: data.moderation.actionNames,
        subject: data.moderation.actionTaken.emailSubject,
        content: data.moderation.actionTaken.emailContent,
      });
    } catch {
      // A malformed locale file falls back to English below.
    }
  }
  cachedTemplates = templates;
  return templates;
}

/**
 * Builds the email notifying a local user of a moderation action taken on
 * them.  Built exclusively from moderator-authored fields (the action's
 * provisions and `messageToUser`); reporter-written text never enters this
 * function, so it cannot leak.  The sender is the moderation team's
 * collective identity; the acting moderator is never named.
 */
export async function getModerationActionEmail(options: {
  locale: Intl.Locale;
  to: string;
  action: FlagAction;
  /** The sanctioned content's URL, or `null` for user (profile) reports. */
  targetUrl: string | null;
  /** Where the user can file an appeal. */
  appealUrl: string;
}): Promise<Message> {
  const templates = await loadTemplates();
  const negotiated = negotiateLocale(options.locale, [...templates.keys()]);
  const template = templates.get(negotiated?.baseName ?? "en") ??
    templates.get("en");
  if (template == null) {
    throw new Error("No moderation email template available.");
  }
  const suspensionEnds = options.action.suspensionEnds?.toLocaleString(
    negotiated?.baseName ?? "en",
    { dateStyle: "long", timeStyle: "short", timeZone: "UTC" },
  ) ?? "";
  const actionName = (template.actionNames[options.action.actionType] ??
    options.action.actionType).replaceAll(
      "{{suspensionEnds}}",
      suspensionEnds,
    );
  function substitute(text: string): string {
    return text.replaceAll(
      /\{\{(provisions|target|action|message|appealUrl)\}\}/g,
      (m) => {
        switch (m) {
          case "{{provisions}}":
            return options.action.violatedProvisions.join(", ");
          case "{{target}}":
            return options.targetUrl ?? "-";
          case "{{action}}":
            return actionName;
          case "{{message}}":
            return options.action.messageToUser ?? "";
          case "{{appealUrl}}":
            return options.appealUrl;
          default:
            return "";
        }
      },
    );
  }
  return createMessage({
    from: EMAIL_FROM,
    to: options.to,
    subject: substitute(template.subject),
    content: { text: substitute(template.content) },
  });
}
