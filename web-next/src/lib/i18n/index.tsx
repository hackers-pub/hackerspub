import { loadMessages } from "#i18n";
import { I18nProvider as KobalteI18nProvider } from "@kobalte/core/i18n";
import { type I18n as LinguiI18n, setupI18n } from "@lingui/core";
import { createAsync, query } from "@solidjs/router";
import { resolveAcceptLanguage } from "resolve-accept-language";
import { createContext, type ParentProps, Show, useContext } from "solid-js";
import { getRequestHeader } from "vinxi/http";
import linguiConfig from "../../../lingui.config.ts";

const loadI18n = query(async () => {
  "use server";

  const acceptLanguage = getRequestHeader("Accept-Language");
  const locale = resolveAcceptLanguage(
    acceptLanguage ?? "",
    linguiConfig.locales,
    linguiConfig.sourceLocale,
  );
  const messages = await loadMessages(locale);
  return { locale, messages };
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
