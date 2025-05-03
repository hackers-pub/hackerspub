import { preprocessContentHtml } from "@hackerspub/models/html";
import { POSSIBLE_LOCALES } from "@hackerspub/models/i18n";
import type { RenderedMarkup } from "@hackerspub/models/markup";
import type { Actor, ArticleDraft } from "@hackerspub/models/schema";
import { DIACRITICS, slugify } from "@std/text/unstable-slugify";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { Input } from "../components/Input.tsx";
import { Label } from "../components/Label.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import getFixedT, { type Language } from "../i18n.ts";
import { MarkupTextArea } from "./MarkupTextArea.tsx";
import { TagInput } from "./TagInput.tsx";

export type EditorProps =
  & {
    language: Language;
    class?: string;
    previewUrl: string;
    publishUrl: string;
    defaultTitle?: string;
    defaultContent?: string;
    defaultTags?: string[];
  }
  & ({
    draftUrl: string;
    publishUrlPrefix: string;
  } | {
    slug: string;
    permalink: string;
    articleLanguage: string;
    allowLlmTranslation: boolean;
  });

export function Editor(props: EditorProps) {
  const t = getFixedT(props.language);

  const [preview, setPreview] = useState<
    {
      html: string;
      mentions: { actor: Actor }[];
      hashtags: string[];
      version: number;
    }
  >({ html: "", mentions: [], hashtags: [], version: 0 });
  const [title, setTitle] = useState(props.defaultTitle ?? "");
  const [content, setContent] = useState(props.defaultContent ?? "");
  const [tags, setTags] = useState<string[]>(props.defaultTags ?? []);
  const [updated, setUpdated] = useState(Date.now());
  const [draftTitle, setDraftTitle] = useState(props.defaultTitle ?? "");
  const [draftContent, setDraftContent] = useState(props.defaultContent ?? "");
  const [draftTags, setDraftTags] = useState<string[]>(props.defaultTags ?? []);
  const [draftUpdated, setDraftUpdated] = useState(Date.now());
  const [draftLanguage, setDraftLanguage] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const contentTextArea = useRef<HTMLTextAreaElement | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [publishMode, setPublishMode] = useState(false);
  const [slug, setSlug] = useState<string | null>(
    "slug" in props ? props.slug : null,
  );
  const [language, setLanguage] = useState<string | null>(
    "articleLanguage" in props ? props.articleLanguage : null,
  );
  const [allowLlmTranslation, setAllowLlmTranslation] = useState(
    "allowLlmTranslation" in props ? props.allowLlmTranslation : true,
  );
  const [publishing, setPublishing] = useState(false);
  const slugInput = useRef<HTMLInputElement | null>(null);

  async function renderPreview(markup: string): Promise<void> {
    // TODO: spinner
    const now = Date.now();
    const response = await fetch(props.previewUrl, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "text/markdown; charset=utf-8",
        "Echo-Nonce": `${now}`,
      },
      body: markup,
      credentials: "include",
    });
    const nonce = response.headers.get("Echo-Nonce");
    if (nonce != null) {
      const { html, mentions, hashtags }: RenderedMarkup = await response
        .json();
      setPreview((existingPreview) => {
        const version = parseInt(nonce);
        if (existingPreview.version < version) {
          return {
            html,
            version,
            mentions: Object.values(mentions).map((actor) => ({ actor })),
            hashtags,
          };
        }
        return existingPreview;
      });
    }
  }

  if (preview.version === 0 && content.trim() !== "") {
    renderPreview(content);
  }

  function onInput(event: JSX.TargetedEvent<HTMLTextAreaElement>) {
    const markup = (event.target as HTMLTextAreaElement).value;
    const now = Date.now();
    setContent(markup);
    setUpdated(now);
    renderPreview(markup);
  }

  async function saveDraft(
    draftUrl: string,
    now: number,
  ): Promise<ArticleDraft & { language: string | null }> {
    const response = await fetch(draftUrl, {
      method: "PUT",
      body: JSON.stringify({ title, content, tags }),
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
    });
    const data: ArticleDraft & { language: string | null } = await response
      .json();
    setDraftTitle(data.title);
    setDraftContent(data.content);
    setDraftTags(data.tags);
    setDraftUpdated(now);
    setDraftLanguage(data.language);

    // Show the "Draft saved" indicator
    setDraftSaved(true);
    return data;
  }

  if ("draftUrl" in props) {
    // deno-lint-ignore react-rules-of-hooks
    useEffect(() => {
      const handle = setInterval(() => {
        const now = Date.now();
        if (now - draftUpdated < 5000) return;
        if (now - updated < 5000) return;
        if (
          draftTitle === title && draftContent === content &&
          draftTags.length === tags.length && draftTags.every((v, i) =>
            tags[i] === v
          )
        ) return;
        saveDraft(props.draftUrl, now);
      }, 1000);

      return () => clearInterval(handle);
    }, [
      props.draftUrl,
      title,
      content,
      tags,
      draftTitle,
      draftContent,
      draftUpdated,
      updated,
    ]);
  }

  function switchToPublishMode() {
    setPreviewMode(false);
    if ("draftUrl" in props) {
      saveDraft(props.draftUrl, Date.now()).then((data) => {
        validateAndSetPublishMode(data);
      });
    } else {
      validateAndSetPublishMode();
    }
  }

  function validateAndSetPublishMode(data?: ArticleDraft) {
    if ((data?.title ?? draftTitle).trim() === "") {
      alert(t("editor.titleRequired"));
      return;
    } else if ((data?.content ?? draftContent).trim() === "") {
      alert(t("editor.contentRequired"));
      return;
    } else if ((data?.tags ?? draftTags).length < 1) {
      alert(t("editor.tagsRequired"));
      return;
    }
    setPublishMode(true);
  }

  async function publish() {
    setPublishing(true);
    const response = await fetch(props.publishUrl, {
      method: "POST",
      body: JSON.stringify({
        title,
        content,
        tags,
        slug: slug ?? makeSlug(draftTitle),
        language: language ?? draftLanguage ?? props.language,
        allowLlmTranslation,
      }),
      redirect: "manual",
      credentials: "include",
    });
    if (response.status === 409) {
      alert(t("editor.publishMode.slugAlreadyTaken"));
      setPublishing(false);
      slugInput.current?.focus();
      return;
    }
    const redirect = response.headers.get("Location");
    if (response.status !== 201 || redirect == null) {
      alert(t("editor.publishMode.failed"));
      setPublishing(false);
      return;
    }
    location.href = redirect;
  }

  const intl = new Intl.DisplayNames(props.language, { type: "language" });

  return (
    <TranslationSetup language={props.language}>
      <div class={`flex ${props.class}`}>
        <div
          class={`
            basis-full lg:basis-1/2 flex-col
            ${previewMode ? "hidden lg:flex" : "flex"}
            ${publishMode ? "hidden" : ""}
          `}
        >
          <div class="border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
            <input
              ref={titleInput}
              type="text"
              required
              placeholder={t("editor.titlePlaceholder")}
              class="w-full text-xl p-3 dark:bg-stone-900 dark:text-white border-4 border-transparent focus:border-stone-200 dark:focus:border-stone-700 focus:outline-none"
              value={title}
              onInput={(event) =>
                setTitle((event.target as HTMLInputElement).value)}
              onKeyDown={(event) => {
                setTitle((event.target as HTMLInputElement).value);
                if (event.key === "Enter") {
                  event.preventDefault();
                  contentTextArea.current?.focus();
                }
              }}
            />
          </div>
          <div class="grow">
            <MarkupTextArea
              ref={contentTextArea}
              required
              placeholder={t("editor.contentPlaceholder")}
              class="w-full h-full resize-none text-xl p-3 dark:bg-stone-900 dark:text-white border-4 border-transparent focus:border-stone-200 dark:focus:border-stone-700 focus:outline-none font-mono"
              onInput={onInput}
              value={content}
            />
          </div>
          <div class="flex lg:hidden border-t border-t-stone-300 dark:border-t-stone-600">
            <Button onClick={switchToPublishMode}>
              <Msg $key="editor.publish" />
            </Button>
            <TagInput
              class="grow"
              tags={tags}
              onTagsChange={setTags}
            />
            <Button onClick={() => setPreviewMode(true)}>
              <Msg $key="editor.preview" />
            </Button>
          </div>
        </div>
        <div
          class={`
            basis-full lg:basis-1/2 flex-col
            ${previewMode ? "flex" : "hidden lg:flex"}
            ${
            publishMode
              ? ""
              : "lg:border-l-[1px] lg:border-l-stone-300 lg:dark:border-l-stone-600"
          }
          `}
        >
          {publishMode
            ? (
              <h1 class="text-2xl p-4 border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
                {draftTitle}
              </h1>
            )
            : (
              <>
                {previewMode && (
                  <h1 class="lg:hidden text-2xl p-4 border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
                    {draftTitle}
                  </h1>
                )}
                <div class="hidden lg:flex border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
                  <TagInput
                    class="grow"
                    tags={tags}
                    onTagsChange={setTags}
                  />
                  <Button onClick={switchToPublishMode}>
                    <Msg $key="editor.publish" />
                  </Button>
                </div>
              </>
            )}
          <div class="grow overflow-y-scroll p-4 text-xl">
            <div
              class="prose dark:prose-invert"
              dangerouslySetInnerHTML={{
                __html: preprocessContentHtml(
                  preview.html,
                  {
                    ...preview,
                    emojis: {},
                    tags: Object.fromEntries(
                      preview.hashtags.map(
                        (tag) => [
                          `#${tag.replace(/^#/, "")}`,
                          `/tags/${encodeURIComponent(tag.replace(/^#/, ""))}`,
                        ],
                      ),
                    ),
                  },
                ),
              }}
            />
          </div>
          {previewMode &&
            (
              <div class="flex lg:hidden border-t border-t-stone-300 dark:border-t-stone-600">
                <Button onClick={switchToPublishMode} class="lg:hidden">
                  <Msg $key="editor.publish" />
                </Button>
                <TagInput
                  class="grow"
                  tags={tags}
                  onTagsChange={setTags}
                />
                <Button onClick={() => setPreviewMode(false)}>
                  <Msg $key="editor.edit" />
                </Button>
              </div>
            )}
        </div>
        {publishMode &&
          (
            <div class="basis-full lg:basis-1/2 flex flex-col lg:border-l lg:border-l-stone-300 lg:dark:border-l-stone-600">
              <div class="p-4">
                <PageTitle>
                  <Msg $key="editor.publishMode.title" />
                </PageTitle>
                <p>
                  <Msg $key="editor.publishMode.description" />
                </p>
                <div class="flex flex-col gap-4 mt-4">
                  <div>
                    <Label label={t("editor.publishMode.slug")}>
                      <Input
                        ref={slugInput}
                        value={slug ?? makeSlug(draftTitle)}
                        readOnly={"slug" in props}
                        disabled={"slug" in props}
                        maxlength={128}
                        onInput={(e) => {
                          const input = e.target as HTMLInputElement;
                          setSlug(input.value);
                        }}
                        onChange={(e) => {
                          const input = e.target as HTMLInputElement;
                          setSlug(makeSlug(input.value));
                        }}
                        class="w-full"
                      />
                    </Label>
                    <p class="opacity-50">
                      <Msg $key="editor.publishMode.slugDescription" />
                      <br />
                      <strong>
                        {"permalink" in props ? props.permalink : new URL(
                          `./${new Date().getFullYear()}/${
                            slug ?? makeSlug(draftTitle)
                          }`,
                          props.publishUrlPrefix,
                        ).href}
                      </strong>
                    </p>
                  </div>
                  <div>
                    <Label label={t("editor.publishMode.language")}>
                      <select
                        class="border-[1px] bg-stone-200 border-stone-500 dark:bg-stone-700 dark:border-stone-600 dark:text-white cursor-pointer p-2"
                        onInput={(event) =>
                          setLanguage(
                            (event.target as HTMLSelectElement).value,
                          )}
                      >
                        {POSSIBLE_LOCALES
                          .map((lang) => [lang, intl.of(lang) ?? ""])
                          .toSorted(([_, a], [__, b]) =>
                            a < b ? -1 : a > b ? 1 : 0
                          )
                          .map(([lang, displayName]) => {
                            const nativeName = new Intl.DisplayNames(lang, {
                              type: "language",
                            }).of(lang);
                            return (
                              <option
                                value={lang}
                                selected={(language ?? draftLanguage) === lang}
                              >
                                {nativeName != null &&
                                    nativeName !== displayName
                                  ? `${displayName} (${nativeName})`
                                  : displayName}
                              </option>
                            );
                          })}
                      </select>
                    </Label>
                  </div>
                  <div>
                    <label class="cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allowLlmTranslation}
                        onInput={(event) =>
                          setAllowLlmTranslation(
                            (event.target as HTMLInputElement).checked,
                          )}
                      />{" "}
                      <Msg $key="editor.publishMode.allowLlmTranslation" />
                    </label>
                  </div>
                  <div class="flex w-full">
                    <div class="grow">
                      <Button
                        disabled={publishing}
                        onClick={() => setPublishMode(false)}
                      >
                        <Msg $key="editor.publishMode.cancel" />
                      </Button>
                    </div>
                    <div class="text-right">
                      <Button disabled={publishing} onClick={publish}>
                        {publishing
                          ? <Msg $key="editor.publishMode.loading" />
                          : <Msg $key="editor.publishMode.submit" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
      </div>
      {draftSaved && !publishMode && (
        <div class="fixed bottom-20 right-4 lg:bottom-6 lg:right-6 bg-stone-300 text-white px-4 py-2 rounded-lg text-sm shadow-lg bg-opacity-60">
          <Msg
            $key="editor.draftSaved"
            saved={new Date(draftUpdated).toLocaleTimeString(props.language, {
              timeStyle: "short",
            })}
          />
        </div>
      )}
    </TranslationSetup>
  );
}

function makeSlug(title: string): string {
  return slugify(title, { strip: DIACRITICS });
}
