import { A } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface LanguageFilterProps {
  readonly languages: readonly string[];
  readonly activeLanguage: string | undefined;
  readonly buildHref: (lang: string | undefined) => string;
}

export function LanguageFilter(props: LanguageFilterProps) {
  const { t, i18n } = useLingui();

  // Display name in the current UI locale ("Korean", "日本語", "英語")
  const uiNames = createMemo(() =>
    new Intl.DisplayNames(i18n.locale, { type: "language", fallback: "code" })
  );

  const pillClass = (active: boolean) =>
    [
      "rounded-full border px-3 py-1.5 text-sm transition-colors",
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    ].join(" ");

  // Ensure the active language is always shown even if it isn't in the
  // suggested list (e.g. manually typed in the URL).
  const languages = createMemo(() => {
    const active = props.activeLanguage;
    if (active == null || props.languages.includes(active)) {
      return props.languages;
    }
    return [active, ...props.languages];
  });

  // Build all native names at once so we create one Intl.DisplayNames per
  // language (keyed by that language's locale) outside the per-item loop.
  const nativeNames = createMemo(() => {
    const map = new Map<string, string>();
    for (const lang of languages()) {
      try {
        map.set(
          lang,
          new Intl.DisplayNames(lang, {
            type: "language",
            fallback: "code",
          }).of(lang) ?? lang,
        );
      } catch {
        map.set(lang, uiNames().of(lang) ?? lang);
      }
    }
    return map;
  });

  return (
    <div class="flex flex-wrap gap-2 border-b px-4 py-3">
      <A
        href={props.buildHref(undefined)}
        class={pillClass(props.activeLanguage == null)}
      >
        {t`All languages`}
      </A>
      <For each={languages()}>
        {(lang) => {
          const nativeName = () => nativeNames().get(lang) ?? lang;
          const uiName = () => uiNames().of(lang) ?? lang;
          const active = () => props.activeLanguage === lang;
          const showUiName = () =>
            uiName().toLowerCase() !== nativeName().toLowerCase();

          return (
            <A
              href={props.buildHref(lang)}
              class={pillClass(active())}
              lang={lang}
            >
              <span>{nativeName()}</span>
              <Show when={showUiName()}>
                <span
                  class={active()
                    ? "ml-1.5 text-xs opacity-60"
                    : "ml-1.5 text-xs text-muted-foreground"}
                >
                  {uiName()}
                </span>
              </Show>
            </A>
          );
        }}
      </For>
    </div>
  );
}
