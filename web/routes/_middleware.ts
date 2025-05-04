import {
  isLocale,
  type Locale,
  normalizeLocale,
} from "@hackerspub/models/i18n";
import { acceptsLanguages } from "@std/http/negotiation";
import * as models from "../ai.ts";
import { db } from "../db.ts";
import { drive } from "../drive.ts";
import { federation } from "../federation.ts";
import getFixedT, {
  DEFAULT_LANGUAGE,
  isLanguage,
  type Language,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
} from "../i18n.ts";
import { kv } from "../kv.ts";
import { define } from "../utils.ts";

export const handler = define.middleware([
  (ctx) => {
    const fedCtx = federation.createContext(ctx.req, {
      db,
      kv,
      disk: drive.use(),
      models,
    });
    ctx.state.fedCtx = fedCtx;
    ctx.state.canonicalOrigin = fedCtx.canonicalOrigin;
    return ctx.next();
  },
  async (ctx) => {
    const { session, account } = await ctx.state.sessionPromise ?? {};
    ctx.state.session = session;
    ctx.state.account = account;
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
          ctx.state.language = isLanguage(language)
            ? language
            : normalizeLanguage(language) ?? DEFAULT_LANGUAGE;
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
      .map((locale) =>
        locale === "*" ? DEFAULT_LANGUAGE : normalizeLocale(locale)
      )
      .filter((l): l is Locale => l != null && isLocale(l));
    ctx.state.t = getFixedT(ctx.state.language);
    ctx.state.title = "Hackers' Pub";
    ctx.state.metas ??= [];
    ctx.state.links ??= [];
    return ctx.next();
  },
]);
