import { negotiateLocale } from "@hackerspub/models/i18n";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { LocaleSelect_availableLocales$key } from "./__generated__/LocaleSelect_availableLocales.graphql.ts";

export interface LocaleSelectProps {
  readonly $availableLocales: LocaleSelect_availableLocales$key;
  readonly value: string;
  onChange(value: string): void;
  readonly class?: string;
}

export function LocaleSelect(props: LocaleSelectProps) {
  const { i18n } = useLingui();
  const availableLocales = createFragment(
    graphql`
      fragment LocaleSelect_availableLocales on Query {
        availableLocales
      }
    `,
    () => props.$availableLocales,
  );
  return (
    <Select
      value={toLocaleInfo(
        negotiateLocale(
          props.value,
          availableLocales()?.availableLocales ?? [],
        )?.baseName ?? "en",
        i18n.locale,
      )}
      onChange={(o) => props.onChange(o?.code ?? "en")}
      options={mapLocaleInfo(
        availableLocales()?.availableLocales ?? [],
        i18n.locale,
      )}
      optionValue="code"
      optionTextValue="name"
      itemComponent={(props) => (
        <SelectItem item={props.item}>
          {props.item.rawValue.name}
          <Show
            when={props.item.rawValue.name !==
              props.item.rawValue.nativeName}
          >
            <span
              class="text-xs text-muted-foreground pl-1.5"
              lang={props.item.rawValue.code}
            >
              {props.item.rawValue.nativeName}
            </span>
          </Show>
        </SelectItem>
      )}
      class={props.class}
    >
      <SelectTrigger>
        <SelectValue<LocaleInfo>>
          {(state) => (
            <>
              {state.selectedOption().name}
              <Show
                when={state.selectedOption().name !==
                  state.selectedOption().nativeName}
              >
                <span
                  class="text-xs text-muted-foreground pl-1.5"
                  lang={state.selectedOption().code}
                >
                  {state.selectedOption().nativeName}
                </span>
              </Show>
            </>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

interface LocaleInfo {
  readonly code: string;
  readonly name: string;
  readonly nativeName: string;
}

function toLocaleInfo(locale: string, currentLocale: string): LocaleInfo {
  return mapLocaleInfo([locale], currentLocale)[0];
}

function mapLocaleInfo(
  locales: readonly string[],
  currentLocale: string,
): LocaleInfo[] {
  const displayNames = new Intl.DisplayNames(currentLocale, {
    type: "language",
  });
  const list = locales.map((l) => {
    const nativeNames = new Intl.DisplayNames(l, { type: "language" });
    return ({
      code: l,
      name: displayNames.of(l) ?? l,
      nativeName: nativeNames.of(l) ?? l,
    });
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}
