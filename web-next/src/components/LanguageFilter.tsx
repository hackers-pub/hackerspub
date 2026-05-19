import { A } from "@solidjs/router";
import { For } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface LanguageFilterProps {
  readonly languages: readonly string[];
  readonly activeLanguage: string | undefined;
  readonly buildHref: (lang: string | undefined) => string;
}

export function LanguageFilter(props: LanguageFilterProps) {
  const { t, i18n } = useLingui();
  const displayNames = () =>
    new Intl.DisplayNames(i18n.locale, { type: "language", fallback: "code" });

  const pillClass = (active: boolean) =>
    [
      "rounded-full border px-3 py-1 text-sm transition-colors",
      active
        ? "border-primary bg-primary text-primary-foreground"
        : "border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    ].join(" ");

  return (
    <div class="flex flex-wrap gap-2 border-b px-4 py-3">
      <A
        href={props.buildHref(undefined)}
        class={pillClass(props.activeLanguage == null)}
      >
        {t`All languages`}
      </A>
      <For each={props.languages}>
        {(lang) => (
          <A
            href={props.buildHref(lang)}
            class={pillClass(props.activeLanguage === lang)}
            lang={lang}
          >
            {displayNames().of(lang) ?? lang}
          </A>
        )}
      </For>
    </div>
  );
}
