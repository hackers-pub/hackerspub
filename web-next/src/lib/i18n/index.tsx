import { loadMessages } from "#i18n";
import { negotiateLocale } from "@hackerspub/models/i18n";
import { I18nProvider as KobalteI18nProvider } from "@kobalte/core/i18n";
import { type I18n as LinguiI18n, setupI18n } from "@lingui/core";
import { createAsync, query } from "@solidjs/router";
import { parseAcceptLanguage } from "intl-parse-accept-language";
import { graphql, readInlineData } from "relay-runtime";
import { createContext, type ParentProps, Show, useContext } from "solid-js";
import { getQuery, getRequestHeader } from "vinxi/http";
import linguiConfig from "../../../lingui.config.ts";
import type { i18nProviderLoadI18n_query$key } from "./__generated__/i18nProviderLoadI18n_query.graphql.ts";

const loadI18n = query(async ($query: i18nProviderLoadI18n_query$key) => {
  "use server";

  const query = getQuery();
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
  if (typeof query.lang === "string") {
    loc = negotiateLocale(query.lang, linguiConfig.locales);
  }
  if (loc == null && accountLocales != null && accountLocales.length > 0) {
    loc = negotiateLocale(accountLocales, linguiConfig.locales);
  }
  if (loc == null) {
    const acceptLanguage = getRequestHeader("Accept-Language");
    const acceptLanguages = parseAcceptLanguage(acceptLanguage);
    loc = negotiateLocale(acceptLanguages, linguiConfig.locales);
  }
  if (loc == null) {
    loc = new Intl.Locale(linguiConfig.sourceLocale);
  }

  const messages = await loadMessages(loc.baseName);
  return { locale: loc.baseName, messages };
}, "i18n");

const I18nContext = createContext<LinguiI18n>();

export interface I18nProviderProps {
  readonly $query: i18nProviderLoadI18n_query$key;
}

export function I18nProvider(props: ParentProps<I18nProviderProps>) {
  const locale = createAsync(() => loadI18n(props.$query));
  const i18n = () => {
    const loaded = locale();
    if (!loaded) return;
    return setupI18n({
      locale: loaded.locale,
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
