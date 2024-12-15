import { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import { TextArea } from "../components/TextArea.tsx";
import { Language, POSSIBLE_LANGUAGES, SUPPORTED_LANGUAGES } from "../i18n.ts";
import { detectAll } from "tinyld.browser";
import { getFixedT } from "i18next";

export interface ComposerProps {
  language: Language;
  postUrl: string;
}

// @ts-ignore: It will be initialized in the loop below.
const languageDisplayNames: Record<Language, Intl.DisplayNames> = {};

for (const language of SUPPORTED_LANGUAGES) {
  languageDisplayNames[language] = new Intl.DisplayNames(language, {
    type: "language",
  });
}

export function Composer(props: ComposerProps) {
  const t = getFixedT(props.language);

  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const [content, setContent] = useState<string>("");
  const [contentLanguage, setContentLanguage] = useState<string>(
    props.language,
  );
  const [contentLanguageManuallySet, setContentLanguageManually] = useState(
    false,
  );
  const [submitting, setSubmitting] = useState(false);

  function onInput(event: JSX.TargetedInputEvent<HTMLTextAreaElement>) {
    if (contentLanguageManuallySet) return;
    const value = event.currentTarget.value;
    setContent(value);
    const result = detectAll(value);
    for (const pair of result) {
      if (pair.lang === props.language) pair.accuracy += 0.5;
      pair.accuracy /= 2;
    }
    result.sort((a, b) => b.accuracy - a.accuracy);
    const detected = result[0]?.lang;
    if (detected != null) setContentLanguage(detected);
  }

  async function onSubmit(event: JSX.TargetedSubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    const content = data.get("content") as string;
    const visibility = data.get("visibility") as string;
    const language = data.get("language") as string;
    const response = await fetch(form.action, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content, visibility, language }),
    });
    if (response.status < 200 || response.status >= 300) {
      alert(t("composer.postFailed"));
      setSubmitting(false);
      return;
    }
    setContent("");
    location.reload();
  }

  return (
    <TranslationSetup language={props.language}>
      <form
        method="post"
        action={props.postUrl}
        onSubmit={onSubmit}
        class="flex flex-col"
      >
        <TextArea
          ref={contentRef}
          name="content"
          required
          class="w-full text-xl mb-3"
          placeholder={t("composer.contentPlaceholder")}
          value={content}
          onInput={onInput}
          aria-label={t("composer.content")}
        />
        <div class="flex">
          <Button disabled={submitting}>
            <Msg $key="composer.post" />
          </Button>
          <div class="ml-auto flex gap-2">
            <select
              name="visibility"
              class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
              aria-label={t("composer.visibility")}
            >
              <option value="public">
                <Msg $key="postVisibility.public" />
              </option>
              <option value="unlisted">
                <Msg $key="postVisibility.unlisted" />
              </option>
              <option value="followers">
                <Msg $key="postVisibility.followers" />
              </option>
              <option value="direct">
                <Msg $key="postVisibility.direct" />
              </option>
            </select>
            <select
              name="language"
              class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
              aria-label={t("composer.language")}
              onSelect={() => setContentLanguageManually(true)}
            >
              {POSSIBLE_LANGUAGES
                .map((
                  lang,
                ) => [
                  lang,
                  languageDisplayNames[props.language].of(lang) ?? "",
                ])
                .toSorted(([_, a], [__, b]) => a < b ? -1 : a > b ? 1 : 0)
                .map(([lang, displayName]) => {
                  const nativeName = new Intl.DisplayNames(lang, {
                    type: "language",
                  })
                    .of(lang);
                  return (
                    <option value={lang} selected={lang === contentLanguage}>
                      {nativeName != null &&
                          nativeName !== displayName
                        ? `${displayName} (${nativeName})`
                        : displayName}
                    </option>
                  );
                })}
            </select>
          </div>
        </div>
      </form>
    </TranslationSetup>
  );
}
