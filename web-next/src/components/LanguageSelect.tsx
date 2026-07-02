import { POSSIBLE_LOCALES } from "@hackerspub/models/i18n";
import { createMemo, Show } from "solid-js";
import {
  Combobox,
  ComboboxContent,
  ComboboxControl,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxItemLabel,
  ComboboxTrigger,
} from "~/components/ui/combobox.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface LanguageSelectProps {
  readonly class?: string;
  readonly classList?: { [k: string]: boolean | undefined };
  readonly exclude?: readonly Intl.Locale[];
  readonly value?: Intl.Locale | null;
  onChange?(value?: Intl.Locale): void;
}

interface LocaleInfo {
  readonly code: string;
  readonly name: string;
  readonly nativeName: string;
  readonly fullName: string;
  readonly disabled: boolean;
}

// `Intl.DisplayNames` instances are expensive: each one loads CLDR tables for
// its target locale. With ~200 entries in POSSIBLE_LOCALES we'd otherwise
// allocate that many tables on every read of `locales()`. Cache per-locale
// formatters once at module scope and reuse them.
const nativeDisplayNamesCache = new Map<string, Intl.DisplayNames>();
function getNativeDisplayNames(locale: string): Intl.DisplayNames {
  let dn = nativeDisplayNamesCache.get(locale);
  if (dn == null) {
    dn = new Intl.DisplayNames(locale, { type: "language" });
    nativeDisplayNamesCache.set(locale, dn);
  }
  return dn;
}

const englishNames = new Intl.DisplayNames("en", { type: "language" });

export function LanguageSelect(props: LanguageSelectProps) {
  const { t, i18n } = useLingui();
  const displayNames = createMemo(() =>
    new Intl.DisplayNames(i18n.locale, { type: "language" })
  );
  const locales = createMemo(() => {
    const dn = displayNames();
    const localeCodes: string[] = [...POSSIBLE_LOCALES];
    if (props.value != null && !localeCodes.includes(props.value.baseName)) {
      localeCodes.push(props.value.baseName);
    }
    const exclude = props.exclude;
    const result = localeCodes.map<LocaleInfo>((locale) => {
      const name = dn.of(locale) ?? locale;
      const nativeName = getNativeDisplayNames(locale).of(locale) ?? locale;
      return {
        code: locale,
        name,
        nativeName,
        fullName: `${locale}\n${name}\n${nativeName}\n${
          englishNames.of(locale) ?? ""
        }`
          .trim(),
        disabled: exclude?.some((l) => l.baseName === locale) ?? false,
      };
    });
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  });
  return (
    <Combobox<LocaleInfo>
      options={locales()}
      optionValue="code"
      optionTextValue="fullName"
      optionLabel="name"
      placeholder={t`Search a language…`}
      itemComponent={(props) => (
        <ComboboxItem item={props.item}>
          <ComboboxItemLabel>
            {props.item.rawValue.name}
            <Show
              when={props.item.rawValue.name !== props.item.rawValue.nativeName}
            >
              <span class="pl-1.5 text-xs text-muted-foreground">
                {props.item.rawValue.nativeName}
              </span>
            </Show>
          </ComboboxItemLabel>
          <ComboboxItemIndicator />
        </ComboboxItem>
      )}
      class={props.class}
      classList={props.classList}
      value={props.value === null
        ? null
        : typeof props.value === "undefined"
        ? undefined
        : locales().find((l) => l.code === props.value!.baseName)}
      onChange={(value) =>
        props.onChange?.(
          value == null ? undefined : new Intl.Locale(value?.code),
        )}
    >
      <ComboboxControl aria-label={t`Language`}>
        <ComboboxInput />
        <ComboboxTrigger />
      </ComboboxControl>
      <ComboboxContent />
    </Combobox>
  );
}
