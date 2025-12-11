import { preprocessContentHtml } from "@hackerspub/models/html";
import { POSSIBLE_LOCALES } from "@hackerspub/models/i18n";
import { detectLanguage } from "@hackerspub/models/langdet";
import type { RenderedMarkup } from "@hackerspub/models/markup";
import type { Actor, Post, PostVisibility } from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import { getFixedT } from "i18next";
import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import { TextArea } from "../components/TextArea.tsx";
import { type Language, SUPPORTED_LANGUAGES } from "../i18n.ts";
import {
  clearNoteDraft,
  getNoteDraft,
  hasDraft,
  type NoteDraft,
  saveNoteDraft,
} from "../lib/draft-storage.ts";
import { MarkupTextArea } from "./MarkupTextArea.tsx";
import { QuotedPostCard } from "./QuotedPostCard.tsx";

const SUPPORTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export interface ComposerProps {
  class?: string;
  language: Language;
  postUrl: string;
  commentTargets?: string[];
  quotedPostId?: Uuid | null;
  noQuoteOnPaste?: boolean;
  textAreaId?: string;
  // deno-lint-ignore no-explicit-any
  onPost: "reload" | "post.url" | ((json: any) => void);
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
  const [mentions, setMentions] = useState<{ actor: Actor }[]>([]);
  const [hashtags, setHashtags] = useState<string[]>([]);
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
  const [quotedPostId, setQuotedPostId] = useState<Uuid | null>(
    props.quotedPostId ?? null,
  );
  const [quoteLoading, setQuoteLoading] = useState(false);

  // Draft auto-save states
  const [savedDraft, setSavedDraft] = useState<NoteDraft | null>(null);
  const [showDraftSaved, setShowDraftSaved] = useState(false);
  const saveTimeoutRef = useRef<number | null>(null);
  const hideIndicatorTimeoutRef = useRef<number | null>(null);

  function onInput(event: JSX.TargetedInputEvent<HTMLTextAreaElement>) {
    if (contentLanguageManuallySet) return;
    const value = event.currentTarget.value;
    setContent(value);
    // FIXME: `acceptLanguage === null` ok?
    const detected = detectLanguage({ text: value, acceptLanguage: null });
    if (detected != null) setContentLanguage(detected);

    // Clear draft if content becomes empty
    if (!value.trim() && hasDraft()) {
      clearNoteDraft();
      setSavedDraft(null);
    } else {
      scheduleDraftSave();
    }
  }

  function onKeyPress(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) {
    const form = event.currentTarget.form;
    if (form == null) return;
    if (
      event.key === "Enter" && (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      submit(form);
    }
  }

  function onPreview(event: JSX.TargetedMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setMode("previewLoading");
    fetch("/api/preview", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "text/markdown; charset=utf-8",
        "Echo-Nonce": Math.random().toString(),
      },
      body: content,
      credentials: "include",
    })
      .then((response) => response.json())
      .then(({ html, mentions, hashtags }: RenderedMarkup) => {
        setMode("preview");
        setContentHtml(html);
        setMentions(Object.values(mentions).map((actor) => ({ actor })));
        setHashtags(hashtags);
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
      } else if (item.kind === "string" && item.type === "text/plain") {
        if (props.noQuoteOnPaste) continue;
        item.getAsString((text) => {
          if (!URL.canParse(text)) return;
          setQuoteLoading(true);
          fetch(`/api/posts?iri=${encodeURIComponent(text)}`).then(
            async (r) => {
              if (!r.ok) {
                setQuoteLoading(false);
                return;
              }
              const pastedPost: Post = await r.json();
              const confirmMsg = t(
                pastedPost.type === "Article"
                  ? "composer.quoteArticleConfirm"
                  : "composer.quoteNoteConfirm",
              );
              setQuoteLoading(false);
              if (
                pastedPost.visibility !== "public" &&
                pastedPost.visibility !== "unlisted"
              ) {
                return;
              }
              if (confirm(confirmMsg)) {
                setQuotedPostId(pastedPost.id);
                setContent(content);
              }
            },
          );
        });
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

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    const content = data.get("content") as string;
    const visibility = data.get("visibility") as string;
    const language = data.get("language") as string;
    const quotedPostId = data.get("quotedPostId") as Uuid | null;
    const response = await fetch(form.action, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        visibility,
        language,
        media,
        quotedPostId,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      alert(t("composer.postFailed"));
      setSubmitting(false);
      return;
    }
    // deno-lint-ignore no-explicit-any
    let post: any;
    try {
      post = await response.json();
    } catch {
      alert(t("composer.postFailed"));
      setSubmitting(false);
      return;
    }
    setContent("");
    clearNoteDraft(); // Clear draft after successful post
    if (props.onPost === "reload") location.reload();
    else if (props.onPost === "post.url") {
      location.href = post.url;
    } else props.onPost(post);
  }

  function onSubmit(event: JSX.TargetedSubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    submit(event.currentTarget);
  }

  const saveDraft = useCallback(() => {
    // Skip if nothing to save (empty content)
    if (!content.trim() && media.length === 0) return;

    const currentDraft: NoteDraft = {
      content,
      visibility,
      language: contentLanguage,
      media,
      quotedPostId,
      timestamp: Date.now(),
    };

    // Skip if nothing changed
    if (
      savedDraft &&
      savedDraft.content === currentDraft.content &&
      savedDraft.visibility === currentDraft.visibility &&
      savedDraft.language === currentDraft.language &&
      JSON.stringify(savedDraft.media) === JSON.stringify(currentDraft.media) &&
      savedDraft.quotedPostId === currentDraft.quotedPostId
    ) {
      return;
    }

    // Save to localStorage
    const success = saveNoteDraft(currentDraft);

    if (success) {
      setSavedDraft(currentDraft);
      setShowDraftSaved(true);

      // Clear existing hide timeout
      if (hideIndicatorTimeoutRef.current !== null) {
        clearTimeout(hideIndicatorTimeoutRef.current);
      }

      // Hide indicator after 3s
      hideIndicatorTimeoutRef.current = setTimeout(() => {
        setShowDraftSaved(false);
      }, 3000);
    }
  }, [content, visibility, contentLanguage, media, quotedPostId, savedDraft]);

  const scheduleDraftSave = useCallback(() => {
    // Clear existing timeout
    if (saveTimeoutRef.current !== null) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Schedule new save after 1.5 seconds
    saveTimeoutRef.current = setTimeout(() => {
      saveDraft();
    }, 1500);
  }, [saveDraft]);

  // Load draft on mount
  useEffect(() => {
    const draft = getNoteDraft();
    if (draft && !props.quotedPostId && !props.commentTargets) {
      setSavedDraft(draft);
    }
  }, []);

  // Auto-save when media changes
  useEffect(() => {
    if (media.length > 0 || savedDraft?.media.length) {
      scheduleDraftSave();
    }
  }, [media, savedDraft?.media.length, scheduleDraftSave]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current !== null) {
        clearTimeout(saveTimeoutRef.current);
      }
      if (hideIndicatorTimeoutRef.current !== null) {
        clearTimeout(hideIndicatorTimeoutRef.current);
      }
    };
  }, []);

  function handleVisibilityChange(visibility: PostVisibility) {
    setVisibility(visibility);
    scheduleDraftSave();
  }

  function onRestoreDraft() {
    if (savedDraft == null) return;

    setContent(savedDraft.content);
    setVisibility(savedDraft.visibility);
    setContentLanguage(savedDraft.language);
    setMedia(savedDraft.media);
    setQuotedPostId(savedDraft.quotedPostId);
    clearNoteDraft();
    setSavedDraft(null);
  }

  function onClearDraft() {
    if (confirm(t("composer.clearDraftConfirm"))) {
      clearNoteDraft();
      setSavedDraft(null);
    }
  }

  return (
    <TranslationSetup language={props.language}>
      <form
        method="post"
        action={props.postUrl}
        onSubmit={onSubmit}
        class={`flex flex-col ${props.class ?? ""}`}
      >
        {quotedPostId != null && (
          <QuotedPostCard
            id={quotedPostId}
            noLink
            language={props.language}
            class="mb-4"
          />
        )}
        {mode === "preview" &&
          (
            <div
              class="w-full mb-3 bg-stone-100 dark:bg-stone-800 p-4 prose dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{
                __html: preprocessContentHtml(contentHtml, {
                  mentions,
                  emojis: {},
                  tags: Object.fromEntries(
                    hashtags.map((tag) => [
                      `#${tag.replace(/^#/, "")}`,
                      `/tags/${encodeURIComponent(tag.replace(/^#/, ""))}`,
                    ]),
                  ),
                }),
              }}
            />
          )}

        <div
          class={`
            grid w-full mb-3
            after:content-[attr(data-replicated-value)_'_'] after:whitespace-pre-wrap after:invisible
            after:w-full after:text-xl after:border after:px-2 after:py-1 after:[grid-area:1/1/2/2]
            ${mediaDragging ? "after:border-4" : ""}
            ${mode === "preview" ? "hidden" : ""}
          `}
          data-replicated-value={content}
        >
          <MarkupTextArea
            ref={contentRef}
            id={props.textAreaId}
            name="content"
            required
            disabled={mode === "previewLoading"}
            class={`
              w-full text-xl resize-none overflow-hidden
              border dark:border-stone-500 dark:bg-stone-900
              px-2 py-1 [grid-area:1/1/2/2]
              ${mediaDragging ? "border-4" : ""}
            `}
            placeholder={props.commentTargets != null
              ? props.commentTargets.length > 0
                ? t("composer.commentPlaceholder")
                : t("composer.threadPlaceholder")
              : props.noQuoteOnPaste
              ? t("composer.quotePlaceholder")
              : t("composer.contentPlaceholder")}
            value={content}
            onInput={onInput}
            onKeyPress={onKeyPress}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onPaste={onPaste}
            rows={2}
            aria-label={t("composer.content")}
          />
        </div>
        <div class="flex flex-col lg:flex-row gap-2">
          <select
            name="visibility"
            class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
            aria-label={t("composer.visibility")}
            value={visibility}
            onSelect={(event) => {
              handleVisibilityChange(
                event.currentTarget.value as PostVisibility,
              );
            }}
            onChange={(event) => {
              handleVisibilityChange(
                event.currentTarget.value as PostVisibility,
              );
            }}
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
              class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2 w-full lg:w-auto lg:max-w-96"
              aria-label={t("composer.language")}
              onSelect={() => {
                setContentLanguageManually(true);
                scheduleDraftSave();
              }}
              onChange={() => {
                scheduleDraftSave();
              }}
            >
              {POSSIBLE_LOCALES
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
          <a
            href="/markdown"
            target="_blank"
            class="hidden lg:flex flex-row items-center opacity-50 hover:opacity-100"
          >
            <svg
              fill="currentColor"
              height="128"
              viewBox="0 0 208 128"
              width="208"
              xmlns="http://www.w3.org/2000/svg"
              class="size-8 mr-2 shrink-0"
              stroke="currentColor"
            >
              <g>
                <path
                  clip-rule="evenodd"
                  d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15z"
                  fill-rule="evenodd"
                />
                <path d="m30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z" />
              </g>
            </svg>
            <span class="hidden xl:block">
              <Msg $key="composer.markdownEnabled" />
            </span>
          </a>
          {(savedDraft || hasDraft()) && !content.trim() && (
            <div class="flex flex-row gap-2 lg:contents">
              {savedDraft && (
                <Button
                  type="button"
                  onClick={onRestoreDraft}
                  class="grow lg:grow-0"
                  title={t("composer.restoreDraft")}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    class="size-5 inline-block"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                    />
                  </svg>
                  <span class="ml-1 lg:hidden xl:inline">
                    <Msg $key="composer.restoreDraft" />
                  </span>
                </Button>
              )}
              {hasDraft() && (
                <Button
                  type="button"
                  onClick={onClearDraft}
                  class="grow lg:grow-0"
                  title={t("composer.clearDraft")}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    class="size-5 inline-block"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
                    />
                  </svg>
                  <span class="ml-1 lg:hidden xl:inline">
                    <Msg $key="composer.clearDraft" />
                  </span>
                </Button>
              )}
            </div>
          )}
          <div class="flex flex-row gap-2">
            {!quoteLoading && quotedPostId != null && (
              <>
                <Button
                  type="button"
                  class="grow"
                  onClick={() => {
                    setQuotedPostId(null);
                    scheduleDraftSave();
                  }}
                >
                  <Msg $key="composer.removeQuote" />
                </Button>
                <input type="hidden" name="quotedPostId" value={quotedPostId} />
              </>
            )}
            {quoteLoading && (
              <span class="mt-2 grow">
                <Msg $key="composer.quoteLoading" />
              </span>
            )}
            <Button
              type="button"
              class="grow"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = SUPPORTED_MEDIA_TYPES.join(",");
                input.multiple = true;
                input.onchange = (e) => {
                  const files = (e.target as HTMLInputElement).files;
                  if (files) {
                    for (const file of files) {
                      if (SUPPORTED_MEDIA_TYPES.includes(file.type)) {
                        addMedium(file);
                      }
                    }
                  }
                };
                input.click();
              }}
              title={t("composer.uploadImage")}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                class="size-5 inline-block"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                />
              </svg>
              <span class="ml-1 hidden md:inline">
                <Msg $key="composer.uploadImage" />
              </span>
            </Button>
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
                  onClick={() => {
                    setMedia((media) =>
                      media.filter((_, i) =>
                        i !== idx
                      )
                    );
                  }}
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
      {/* Auto-save indicator */}
      {showDraftSaved && savedDraft && (
        <div
          class="fixed bottom-20 right-4 lg:bottom-6 lg:right-6 bg-stone-800 dark:bg-stone-700 text-white text-sm px-4 py-2 rounded-lg shadow-lg opacity-90 transition-opacity duration-300"
          role="status"
          aria-live="polite"
        >
          ✓ <Msg $key="composer.draftSaved" />{" "}
          {new Date(savedDraft.timestamp).toLocaleTimeString(
            props.language,
            {
              hour: "numeric",
              minute: "2-digit",
            },
          )}
        </div>
      )}
    </TranslationSetup>
  );
}
