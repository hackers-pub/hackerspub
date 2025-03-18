import { useState } from "preact/hooks";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import {
  type Language,
  POSSIBLE_LOCALES,
  SUPPORTED_LANGUAGES,
} from "../i18n.ts";

// @ts-ignore: It will be initialized in the loop below.
const localeDisplayNames: Record<Language, Intl.DisplayNames> = {};

for (const language of SUPPORTED_LANGUAGES) {
  localeDisplayNames[language] = new Intl.DisplayNames(language, {
    type: "language",
  });
}

function getLocaleName(
  language: Language,
  locale: string,
): { locale: string; name: string; nativeName: string } {
  const name = localeDisplayNames[language].of(locale)!;
  const nativeName = (localeDisplayNames[locale as Language] ??
    new Intl.DisplayNames(locale, { type: "language" })).of(locale)!;
  return { locale, name, nativeName };
}

export interface LocalePriorityListProps {
  language: Language;
  selectedLocales: string[];
  name: string;
  class?: string;
}

export function LocalePriorityList(
  { language, class: klass, selectedLocales: defaultLocales, name }:
    LocalePriorityListProps,
) {
  const [selectedLocales, setSelectedLocales] = useState<string[]>(
    defaultLocales,
  );
  const locales = POSSIBLE_LOCALES.map((l) => getLocaleName(language, l));
  locales.sort((a, b) => a.name.localeCompare(b.name, language));
  const selectedSupportedLocales = selectedLocales.filter((l) =>
    SUPPORTED_LANGUAGES.includes(l as Language)
  );
  return (
    <TranslationSetup language={language}>
      <div class={`flex flex-col md:flex-row gap-4 ${klass ?? ""}`}>
        <div class="basis-full md:basis-1/2">
          <div class="mb-4">
            <h3 class="font-bold">
              <Msg $key="localePriorityList.languagesToSelect" />
            </h3>
            <p class="text-stone-600 dark:text-stone-400">
              <Msg
                $key="localePriorityList.languagesToSelectDescription"
                boldText={
                  <strong>
                    <Msg $key="localePriorityList.boldText" />
                  </strong>
                }
              />
            </p>
          </div>
          <ul class="h-[calc(100vh/2)] overflow-y-scroll bg-stone-100 dark:bg-stone-800">
            {locales
              .filter(({ locale }) => !selectedLocales.includes(locale))
              .map(({ locale, name, nativeName }) => (
                <li
                  key={locale}
                  class="
                    cursor-pointer p-4 hover:bg-stone-200 dark:hover:bg-stone-700
                    flex flex-row group
                  "
                  onClick={() =>
                    setSelectedLocales((locales) => [...locales, locale])}
                >
                  {SUPPORTED_LANGUAGES.includes(locale as Language)
                    ? (
                      <strong class="grow">
                        {name}
                        {name !== nativeName && (
                          <span class="ml-2 opacity-50 text-sm">
                            {nativeName}
                          </span>
                        )}
                      </strong>
                    )
                    : (
                      <span class="grow">
                        {name}
                        {name !== nativeName && (
                          <span class="ml-2 opacity-50 text-sm">
                            {nativeName}
                          </span>
                        )}
                      </span>
                    )}
                  <span class="hidden group-hover:block text-right font-bold">
                    &rarr;
                  </span>
                </li>
              ))}
          </ul>
        </div>
        <div class="basis-full md:basis-1/2">
          <div class="mb-4">
            <h3 class="font-bold">
              <Msg $key="localePriorityList.selectedLanguages" />
            </h3>
            <p class="text-stone-600 dark:text-stone-400">
              <Msg $key="localePriorityList.selectedLanguagesDescription" />
            </p>
          </div>
          <ul class="h-[calc(100vh/2)] overflow-y-scroll bg-stone-100 dark:bg-stone-800">
            {selectedLocales
              .map((locale, i) => {
                const { name, nativeName } = getLocaleName(language, locale);
                return (
                  <li
                    key={locale}
                    class="
                      p-4 hover:bg-stone-200 dark:hover:bg-stone-700
                      flex flex-row group gap-2
                    "
                  >
                    {SUPPORTED_LANGUAGES.includes(locale as Language)
                      ? (
                        <strong class="grow">
                          {name}
                          {name !== nativeName && (
                            <span class="ml-2 opacity-50 text-sm">
                              {nativeName}
                            </span>
                          )}
                        </strong>
                      )
                      : (
                        <span class="grow">
                          {name}
                          {name !== nativeName && (
                            <span class="ml-2 opacity-50 text-sm">
                              {nativeName}
                            </span>
                          )}
                        </span>
                      )}
                    <span
                      class={`
                        hidden group-hover:block text-right font-bold px-1
                        ${
                        i < 1 ? "opacity-50 cursor-default" : "cursor-pointer"
                      }
                      `}
                      onClick={i < 1
                        ? undefined
                        : () =>
                          setSelectedLocales((locales) => {
                            const index = locales.indexOf(locale);
                            return [
                              ...locales.slice(0, index - 1),
                              locale,
                              locales[index - 1],
                              ...locales.slice(index + 1),
                            ];
                          })}
                    >
                      &uarr;
                    </span>
                    <span
                      class={`
                        hidden group-hover:block text-right font-bold px-1
                        ${
                        i >= selectedLocales.length - 1
                          ? "opacity-50 cursor-default"
                          : "cursor-pointer"
                      }
                      `}
                      onClick={i >= selectedLocales.length - 1
                        ? undefined
                        : () =>
                          setSelectedLocales((locales) => {
                            const index = locales.indexOf(locale);
                            return [
                              ...locales.slice(0, index),
                              locales[index + 1],
                              locale,
                              ...locales.slice(index + 2),
                            ];
                          })}
                    >
                      &darr;
                    </span>
                    <span
                      class={`
                        hidden group-hover:block text-right font-bold px-1
                        ${
                        selectedLocales.length <= 1 ||
                          selectedSupportedLocales.length <= 1 &&
                            SUPPORTED_LANGUAGES.includes(locale as Language)
                          ? "opacity-50 cursor-default"
                          : "cursor-pointer"
                      }
                      `}
                      onClick={selectedLocales.length <= 1 ||
                          selectedSupportedLocales.length <= 1 &&
                            SUPPORTED_LANGUAGES.includes(locale as Language)
                        ? undefined
                        : () =>
                          setSelectedLocales((locales) =>
                            locales.filter((l) => l !== locale)
                          )}
                    >
                      &times;
                    </span>
                  </li>
                );
              })}
          </ul>
        </div>
      </div>
      {selectedLocales.map((locale) => (
        <input key={locale} type="hidden" name={name} value={locale} />
      ))}
    </TranslationSetup>
  );
}
