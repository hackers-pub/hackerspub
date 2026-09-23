import { Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.ts";

export interface LanguageNameProps {
  readonly code: string;
  readonly class?: string;
  readonly nativeClass?: string;
}

/**
 * Renders a BCP 47 language code as its name in the current UI locale, with the
 * native name in parentheses. The parenthetical is omitted when the language is
 * the UI locale's own language, where it would just repeat the name.
 */
export function LanguageName(props: LanguageNameProps) {
  const { i18n } = useLingui();
  const displayNames = new Intl.DisplayNames(i18n.locale, { type: "language" });
  const localeLanguage = new Intl.Locale(i18n.locale).language;
  const label = () => {
    const locale = new Intl.Locale(props.code);
    const name = displayNames.of(props.code) ?? props.code;
    const nativeName =
      new Intl.DisplayNames(props.code, { type: "language" }).of(props.code) ??
      props.code;
    return {
      name,
      nativeName,
      showNative: locale.language !== localeLanguage && name !== nativeName,
    };
  };
  return (
    <>
      {label().name}
      <Show when={label().showNative}>
        {/* The native name is written in the language it names, not in the UI
            locale, so it carries its own `lang` for screen readers and for
            font selection. */}
        <span
          lang={props.code}
          class={props.nativeClass ?? "ml-1 text-xs text-muted-foreground"}
        >
          ({label().nativeName})
        </span>
      </Show>
    </>
  );
}
