import { loadMessages } from "#i18n";
import { negotiateLocale } from "@hackerspub/models/i18n";
import { I18nProvider as KobalteI18nProvider } from "@kobalte/core/i18n";
import { type I18n as LinguiI18n, setupI18n } from "@lingui/core";
import { createAsync, query } from "@solidjs/router";
import { parseAcceptLanguage } from "intl-parse-accept-language";
import { createContext, type ParentProps, Show, useContext } from "solid-js";
import { getQuery, getRequestHeader } from "vinxi/http";
import linguiConfig from "../../../lingui.config.ts";

const loadI18n = query(async () => {
  "use server";

  const query = getQuery();

  let loc: Intl.Locale | undefined;
  if (typeof query.lang === "string") {
    loc = negotiateLocale(query.lang, linguiConfig.locales);
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

export function I18nProvider(props: ParentProps) {
  const locale = createAsync(() => loadI18n(), { deferStream: true });
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
