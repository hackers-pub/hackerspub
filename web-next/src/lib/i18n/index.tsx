import { loadMessages } from "#i18n";
import { negotiateLocale } from "@hackerspub/models/i18n";
import { I18nProvider as KobalteI18nProvider } from "@kobalte/core/i18n";
import { type I18n as LinguiI18n, setupI18n } from "@lingui/core";
import { createAsync, query, useLocation } from "@solidjs/router";
import { getRequestHeader } from "@solidjs/start/http";
import { parseAcceptLanguage } from "intl-parse-accept-language";
import { graphql, readInlineData } from "relay-runtime";
import { createContext, type ParentProps, Show, useContext } from "solid-js";
import linguiConfig from "../../../lingui.config.ts";
import type { i18nProviderLoadI18n_query$key } from "./__generated__/i18nProviderLoadI18n_query.graphql.ts";

const loadI18n = query(async (
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
  if (langOverride) {
    try {
      loc = negotiateLocale(
        new Intl.Locale(langOverride),
        linguiConfig.locales,
      );
    } catch {
      // Ignore unparseable locale codes from ?lang=… and fall through.
    }
  }
  if (loc == null && accountLocales != null && accountLocales.length > 0) {
    loc = negotiateLocale(accountLocales, linguiConfig.locales);
    locales.push(...accountLocales);
  }
  if (loc == null) {
    const acceptLanguage = getRequestHeader("Accept-Language");
    const acceptLanguages = parseAcceptLanguage(acceptLanguage);
    loc = negotiateLocale(acceptLanguages, linguiConfig.locales);
    locales.push(...acceptLanguages);
  }
  if (loc == null) {
    loc = new Intl.Locale(linguiConfig.sourceLocale);
  }
  if (locales.length < 1) locales.push(loc.baseName);

  const messages = await loadMessages(loc.baseName);
  return { locale: loc.baseName, locales, messages };
}, "i18n");

const I18nContext = createContext<LinguiI18n>();

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
  const i18n = () => {
    const loaded = locale();
    if (!loaded) return;
    return setupI18n({
      locale: loaded.locale,
      locales: loaded.locales,
      messages: {
        [loaded.locale]: loaded.messages,
      },
    });
  };

  return (
    <Show when={i18n()}>
      {(i18n) => (
        <I18nContext.Provider value={i18n()}>
          <KobalteI18nProvider locale={i18n().locale}>
            {props.children}
          </KobalteI18nProvider>
        </I18nContext.Provider>
      )}
    </Show>
  );
}

export function useLinguiImpl() {
  const i18n = useContext(I18nContext);
  if (!i18n) throw new Error("I18nProvider not found");
  return {
    i18n,
    _: i18n._.bind(i18n),
  };
}
