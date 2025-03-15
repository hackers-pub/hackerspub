import { getFixedT } from "i18next";
import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { detectAll } from "tinyld.browser";
import { Button } from "../components/Button.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import { TextArea } from "../components/TextArea.tsx";
import {
  type Language,
  POSSIBLE_LANGUAGES,
  SUPPORTED_LANGUAGES,
} from "../i18n.ts";
import type { PostVisibility } from "../models/schema.ts";

const SUPPORTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export interface ComposerProps {
  class?: string;
  language: Language;
  previewUrl: string;
  postUrl: string;
  commentTargets?: string[];
  textAreaId?: string;
  // deno-lint-ignore no-explicit-any
  onPost: "reload" | ((json: any) => void);
  defaultVisibility?: PostVisibility;
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

  const [mode, setMode] = useState<"edit" | "preview" | "previewLoading">(
    "edit",
  );
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const [content, setContent] = useState<string>(
    (props.commentTargets ?? []).map((t) => `${t} `).join(""),
  );
  const [contentHtml, setContentHtml] = useState("");
  const [contentLanguage, setContentLanguage] = useState<string>(
    props.language,
  );
  const [contentLanguageManuallySet, setContentLanguageManually] = useState(
    false,
  );
  const [submitting, setSubmitting] = useState(false);
  const [mediaDragging, setMediaDragging] = useState(false);
  const [media, setMedia] = useState<{ url: string; alt: string }[]>(
    [],
  );
  const [visibility, setVisibility] = useState<PostVisibility>(
    props.defaultVisibility ?? "public",
  );
  const rows = (content.match(/\n/g)?.length ?? 0) + 1;

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

  function onPreview(event: JSX.TargetedMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setMode("previewLoading");
    fetch(props.previewUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Echo-Nonce": Math.random().toString(),
      },
      body: content,
      credentials: "include",
    })
      .then((response) => response.text())
      .then((html) => {
        setMode("preview");
        setContentHtml(html);
      });
  }

  function onEdit(event: JSX.TargetedMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setMode("edit");
  }

  function isMediaDragEvent(
    event: JSX.TargetedDragEvent<HTMLTextAreaElement>,
  ): event is JSX.TargetedDragEvent<HTMLTextAreaElement> & {
    dataTransfer: DataTransfer;
  } {
    return event.dataTransfer != null && event.dataTransfer.items.length > 0 &&
      [...event.dataTransfer.items].every((i) =>
        i.kind === "file" &&
        SUPPORTED_MEDIA_TYPES.includes(i.type)
      );
  }

  function onDragOver(event: JSX.TargetedDragEvent<HTMLTextAreaElement>) {
    if (isMediaDragEvent(event)) {
      event.preventDefault();
      setMediaDragging(true);
    }
  }

  function onDragLeave(event: JSX.TargetedDragEvent<HTMLTextAreaElement>) {
    if (isMediaDragEvent(event)) {
      setMediaDragging(false);
    }
  }

  function onDrop(event: JSX.TargetedDragEvent<HTMLTextAreaElement>) {
    if (isMediaDragEvent(event)) {
      event.preventDefault();
      for (const f of event.dataTransfer.files) addMedium(f);
      setMediaDragging(false);
    }
  }

  function onPaste(event: JSX.TargetedClipboardEvent<HTMLTextAreaElement>) {
    for (const item of event.clipboardData?.items ?? []) {
      if (item.kind === "file" && SUPPORTED_MEDIA_TYPES.includes(item.type)) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file == null) continue;
        addMedium(file);
      }
    }
  }

  function addMedium(file: File) {
    const reader = new FileReader();
    reader.addEventListener("load", (e) => {
      if (e.target == null || typeof e.target.result !== "string") return;
      const url = e.target.result;
      setMedia((media) => [...media, { url, alt: "" }]);
    });
    reader.readAsDataURL(file);
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
      body: JSON.stringify({ content, visibility, language, media }),
    });
    if (response.status < 200 || response.status >= 300) {
      alert(t("composer.postFailed"));
      setSubmitting(false);
      return;
    }
    // deno-lint-ignore no-explicit-any
    let json: any;
    try {
      json = await response.json();
    } catch {
      alert(t("composer.postFailed"));
      setSubmitting(false);
      return;
    }
    setContent("");
    if (props.onPost === "reload") location.reload();
    else props.onPost(json);
  }

  return (
    <TranslationSetup language={props.language}>
      <form
        method="post"
        action={props.postUrl}
        onSubmit={onSubmit}
        class={`flex flex-col ${props.class ?? ""}`}
      >
        {mode === "preview" &&
          (
            <div
              class="w-full mb-3 bg-stone-100 dark:bg-stone-800 p-4 prose dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: contentHtml }}
            />
          )}

        <TextArea
          ref={contentRef}
          id={props.textAreaId}
          name="content"
          required
          disabled={mode === "previewLoading"}
          class={`w-full text-xl mb-3 ${mediaDragging ? "border-4" : ""} ${
            mode === "preview" ? "hidden" : ""
          }`}
          placeholder={props.commentTargets != null
            ? props.commentTargets.length > 0
              ? t("composer.commentPlaceholder")
              : t("composer.threadPlaceholder")
            : t("composer.contentPlaceholder")}
          value={content}
          onInput={onInput}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onPaste={onPaste}
          rows={Math.min(Math.max(2, rows), 10)}
          aria-label={t("composer.content")}
        />
        <div class="flex flex-col lg:flex-row gap-2">
          <select
            name="visibility"
            class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
            aria-label={t("composer.visibility")}
            value={visibility}
            onSelect={(event) =>
              setVisibility(event.currentTarget.value as PostVisibility)}
            onChange={(event) =>
              setVisibility(event.currentTarget.value as PostVisibility)}
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
          <div class="lg:grow">
            <select
              name="language"
              class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2 w-full lg:w-auto"
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
          <div class="flex flex-row gap-2">
            <Button
              type="button"
              disabled={mode === "previewLoading"}
              onClick={mode === "edit" ? onPreview : onEdit}
              class="grow"
            >
              <Msg
                $key={mode === "preview"
                  ? "composer.edit"
                  : mode === "previewLoading"
                  ? "composer.previewLoading"
                  : "composer.preview"}
              />
            </Button>
            <Button type="submit" disabled={submitting} class="grow">
              <Msg $key="composer.post" />
            </Button>
          </div>
        </div>
        {media.length > 0 && (
          <div>
            {media.map(({ url, alt }, idx) => (
              <div key={idx} class="flex flex-row gap-2 mt-2">
                <img src={url} alt={alt} class="w-48" />
                <TextArea
                  value={alt}
                  onInput={(e) =>
                    setMedia(
                      (media) => [
                        ...media.slice(0, idx),
                        { url: media[idx].url, alt: e.currentTarget.value },
                        ...media.slice(idx + 1),
                      ],
                    )}
                  placeholder={t("composer.mediumAltPlaceholder")}
                  class="w-full"
                  required
                />
                <button
                  type="button"
                  title={t("composer.removeMedium")}
                  class="hover:bg-stone-200 hover:dark:bg-stone-700"
                  onClick={() =>
                    setMedia((media) =>
                      media.filter((_, i) =>
                        i !== idx
                      )
                    )}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="size-6"
                    aria-label={t("composer.removeMedium")}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18 18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </form>
    </TranslationSetup>
  );
}
