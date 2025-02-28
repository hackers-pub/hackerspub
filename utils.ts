/// <reference lib="deno.unstable" />
import type { RequestContext } from "@fedify/fedify";
import { createDefine } from "fresh";
import type getFixedT from "./i18n.ts";
import type { Language } from "./i18n.ts";
import type {
  Account,
  AccountEmail,
  AccountLink,
  Actor,
} from "./models/schema.ts";
import type { Session } from "./models/session.ts";

export interface Link {
  rel: string;
  href: string | URL;
  hreflang?: string;
  type?: string;
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
  fedCtx: RequestContext<void>;
  language: Language;
  t: ReturnType<typeof getFixedT>;
  title: string;
  metas: Meta[];
  links: Link[];
  withoutMain?: boolean;
}

export const define = createDefine<State>();

export function compactUrl(url: string | URL): string {
  url = new URL(url);
  return url.protocol !== "https:" && url.protocol !== "http:"
    ? url.href
    : url.host +
      (url.searchParams.size < 1 && (url.hash === "" || url.hash === "#")
        ? url.pathname.replace(/\/+$/, "")
        : url.pathname) +
      (url.searchParams.size < 1 ? "" : url.search) +
      (url.hash === "#" ? "" : url.hash);
}
