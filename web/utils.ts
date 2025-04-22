/// <reference lib="deno.unstable" />
import type { RequestContext } from "@fedify/fedify";
import { createDefine } from "@fresh/core";
import type { ContextData } from "@hackerspub/federation/builder";
import type { Locale } from "@hackerspub/models/i18n";
import type {
  Account,
  AccountEmail,
  AccountLink,
  Actor,
} from "@hackerspub/models/schema";
import type { Session } from "@hackerspub/models/session";
import type getFixedT from "./i18n.ts";
import type { Language } from "./i18n.ts";

export const MODE = Deno.env.get("MODE") ?? "production";

export interface Link {
  rel: string;
  href: string | URL;
  hreflang?: string;
  type?: string;
  title?: string;
}

export type Meta = {
  name: string;
  content: string | number | URL;
} | {
  property: string;
  content: string | number | URL;
};

export interface State {
  session?: Session;
  account?: Account & {
    actor: Actor;
    emails: AccountEmail[];
    links: AccountLink[];
  };
  canonicalOrigin: string;
  fedCtx: RequestContext<ContextData>;
  language: Language;
  locales: Locale[];
  t: ReturnType<typeof getFixedT>;
  title: string;
  metas: Meta[];
  links: Link[];
  withoutMain?: boolean;
  searchQuery?: string;
}

export const define = createDefine<State>();
