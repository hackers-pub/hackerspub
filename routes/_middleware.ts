import { getCookies } from "@std/http/cookie";
import { acceptsLanguages } from "@std/http/negotiation";
import { db } from "../db.ts";
import { federation } from "../federation/federation.ts";
import getFixedT, {
  DEFAULT_LANGUAGE,
  isLanguage,
  isLocale,
  type Language,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
} from "../i18n.ts";
import { kv } from "../kv.ts";
import { getSession } from "../models/session.ts";
import { validateUuid } from "../models/uuid.ts";
import { define } from "../utils.ts";

export const handler = define.middleware([
  (ctx) => {
    const fedCtx = federation.createContext(ctx.req, undefined);
    ctx.state.fedCtx = fedCtx;
    ctx.state.canonicalOrigin = fedCtx.canonicalOrigin;
    return ctx.next();
  },
  async (ctx) => {
    const cookies = getCookies(ctx.req.headers);
    if (validateUuid(cookies.session)) {
      const session = await getSession(kv, cookies.session);
      if (session != null) {
        const account = await db.query.accountTable.findFirst({
          where: { id: session.accountId },
          with: { actor: true, emails: true, links: true },
        });
        ctx.state.account = account;
        ctx.state.session = account == null ? undefined : session;
      }
    }
    return await ctx.next();
  },
  (ctx) => {
    const lang = normalizeLanguage(ctx.url.searchParams.get("lang"));
    let locales: string[];
    if (lang == null) {
      const { account } = ctx.state;
      if (account?.locales != null) {
        locales = account.locales;
        let found = false;
        for (const locale of locales) {
          if (isLanguage(locale)) {
            ctx.state.language = locale;
            found = true;
            break;
          }
        }
        if (!found) {
          const language = (acceptsLanguages(ctx.req, ...locales) as
            | Language
            | undefined) ??
            DEFAULT_LANGUAGE;
          ctx.state.language = language;
          locales.push(language);
        }
      } else {
        ctx.state.language =
          (acceptsLanguages(ctx.req, ...SUPPORTED_LANGUAGES) as
            | Language
            | undefined) ??
            DEFAULT_LANGUAGE;
        locales = acceptsLanguages(ctx.req);
      }
    } else {
      ctx.state.language = lang;
      locales = acceptsLanguages(ctx.req);
      if (!locales.includes(lang)) locales.unshift(lang);
    }
    ctx.state.locales = locales
      .map((locale) => locale === "*" ? DEFAULT_LANGUAGE : locale)
      .filter(isLocale);
    ctx.state.t = getFixedT(ctx.state.language);
    ctx.state.title = "Hackers' Pub";
    ctx.state.metas ??= [];
    ctx.state.links ??= [];
    return ctx.next();
  },
]);
