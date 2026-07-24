import { loadMessages } from "#i18n";
import { negotiateLocale } from "@hackerspub/models/i18n";
import { I18nProvider as KobalteI18nProvider } from "@kobalte/core/i18n";
import { type I18n as LinguiI18n, setupI18n } from "@lingui/core";
import {
  I18nProvider as LinguiI18nProvider,
  useLingui as useSolidLingui,
} from "@lingui/solid";
import { createAsync, query, useLocation } from "@solidjs/router";
import { getRequestHeader } from "@solidjs/start/http";
import { parseAcceptLanguage } from "intl-parse-accept-language";
import { graphql, readInlineData } from "relay-runtime";
import { createMemo, type ParentProps, Show } from "solid-js";
import linguiConfig from "../../../lingui.config.ts";
import type { i18nProviderLoadI18n_query$key } from "./__generated__/i18nProviderLoadI18n_query.graphql.ts";
import { getValidLocaleBaseNames } from "./locales.ts";

const loadI18n = query(
  async (
    $query: i18nProviderLoadI18n_query$key,
    langOverride: string | undefined,
  ) => {
    "use server";

    const accountLocales = readInlineData(
      graphql`
        fragment i18nProviderLoadI18n_query on Query @inline {
          viewer {
            locales
          }
        }
      `,
      $query,
    ).viewer?.locales;

    let loc: Intl.Locale | undefined;
    const locales: string[] = [];
    const validLangOverride =
      langOverride == null
        ? undefined
        : getValidLocaleBaseNames([langOverride])[0];
    if (validLangOverride != null) {
      try {
        loc = negotiateLocale(
          new Intl.Locale(validLangOverride),
          linguiConfig.locales,
        );
      } catch {
        // Ignore unparseable locale codes from ?lang=… and fall through.
      }
    }
    if (loc == null && accountLocales != null && accountLocales.length > 0) {
      const validAccountLocales = getValidLocaleBaseNames(accountLocales);
      loc = negotiateLocale(validAccountLocales, linguiConfig.locales);
      locales.push(...validAccountLocales);
    }
    if (loc == null) {
      const acceptLanguage = getRequestHeader("Accept-Language");
      const acceptLanguages = getValidLocaleBaseNames(
        parseAcceptLanguage(acceptLanguage),
      );
      loc = negotiateLocale(acceptLanguages, linguiConfig.locales);
      locales.push(...acceptLanguages);
    }
    if (loc == null) {
      loc = new Intl.Locale(linguiConfig.sourceLocale);
    }
    if (locales.length < 1) locales.push(loc.baseName);

    const messages = await loadMessages(loc.baseName);
    return { locale: loc.baseName, locales, messages };
  },
  "i18n",
);

export interface I18nProviderProps {
  readonly $query: i18nProviderLoadI18n_query$key;
}

export function I18nProvider(props: ParentProps<I18nProviderProps>) {
  const location = useLocation();
  const langOverride = () => {
    const value = location.query.lang;
    if (Array.isArray(value)) return value[0] || undefined;
    return value || undefined;
  };
  const locale = createAsync(() => loadI18n(props.$query, langOverride()));
  const i18n = createMemo<LinguiI18n | undefined>((previous) => {
    const loaded = locale();
    if (!loaded) return previous;
    return setupI18n({
      locale: loaded.locale,
      locales: loaded.locales,
      messages: {
        [loaded.locale]: loaded.messages,
      },
    });
  });

  return (
    <Show when={i18n()}>
      {(i18n) => (
        <LinguiI18nProvider i18n={i18n()}>
          <KobalteI18nProvider locale={i18n().locale}>
            {props.children}
          </KobalteI18nProvider>
        </LinguiI18nProvider>
      )}
    </Show>
  );
}

export function useLinguiImpl() {
  const lingui = useSolidLingui();
  const i18n = new Proxy({} as LinguiI18n, {
    get(_target, prop) {
      if (prop === "_") return lingui._;
      const current = lingui.i18n();
      const value = Reflect.get(current, prop, current);
      return typeof value === "function" ? value.bind(current) : value;
    },
    has(_target, prop) {
      return prop in lingui.i18n();
    },
    set(_target, prop, value) {
      const current = lingui.i18n();
      return Reflect.set(current, prop, value, current);
    },
  });
  return {
    i18n,
    _: lingui._,
  };
}
