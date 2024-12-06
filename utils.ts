/// <reference lib="deno.unstable" />
import { createDefine } from "fresh";
import type { Session } from "./models/session.ts";
import type { RequestContext } from "@fedify/fedify";
import type { Account, AccountEmail, Actor } from "./models/schema.ts";
import getFixedT, { type Language } from "./i18n.ts";

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
  account?: Account & { actor: Actor; emails: AccountEmail[] };
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
