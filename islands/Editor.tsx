import { NON_ASCII, slugify } from "@std/text/unstable-slugify";
import transliterate from "any-ascii";
import { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { TagInput } from "./TagInput.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { Label } from "../components/Label.tsx";
import { Input } from "../components/Input.tsx";

export interface EditorProps {
  class?: string;
  previewUrl: string;
  draftUrl: string;
  publishUrl: string;
  publishUrlPrefix: string;
  defaultTitle?: string;
  defaultContent?: string;
  defaultTags?: string[];
}

export function Editor(props: EditorProps) {
  const [previewHtml, setPreviewHtml] = useState<[string, number]>(["", 0]);
  const [title, setTitle] = useState(props.defaultTitle ?? "");
  const [content, setContent] = useState(props.defaultContent ?? "");
  const [tags, setTags] = useState<string[]>(props.defaultTags ?? []);
  const [updated, setUpdated] = useState(Date.now());
  const [draftTitle, setDraftTitle] = useState(props.defaultTitle ?? "");
  const [draftContent, setDraftContent] = useState(props.defaultContent ?? "");
  const [draftTags, setDraftTags] = useState<string[]>(props.defaultTags ?? []);
  const [draftUpdated, setDraftUpdated] = useState(Date.now());
  const [draftLanguage, setDraftLanguage] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const contentTextArea = useRef<HTMLTextAreaElement | null>(null);
  const [publishMode, setPublishMode] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const slugInput = useRef<HTMLInputElement | null>(null);

  async function renderPreview(markup: string): Promise<void> {
    // TODO: spinner
    const now = Date.now();
    const response = await fetch(props.previewUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Echo-Nonce": `${now}`,
      },
      body: markup,
    });
    const nonce = response.headers.get("Echo-Nonce");
    if (nonce != null) {
      const html = await response.text();
      setPreviewHtml(([existingHtml, existingVersion]) => {
        const v = parseInt(nonce);
        if (existingVersion < v) return [html, v];
        return [existingHtml, existingVersion];
      });
    }
  }

  if (previewHtml[1] === 0 && content.trim() !== "") {
    renderPreview(content);
  }

  function onInput(event: JSX.TargetedEvent<HTMLTextAreaElement>) {
    const markup = (event.target as HTMLTextAreaElement).value;
    const now = Date.now();
    setContent(markup);
    setUpdated(now);
    renderPreview(markup);
  }

  async function saveDraft(now: number) {
    const response = await fetch(props.draftUrl, {
      method: "PUT",
      body: JSON.stringify({ title, content, tags }),
      headers: {
        "Content-Type": "application/json",
      },
    });
    const data = await response.json();
    setDraftTitle(data.title);
    setDraftContent(data.content);
    setDraftTags(data.tags);
    setDraftUpdated(now);
    setDraftLanguage(data.language);
  }

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
      saveDraft(now);
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

  function switchToPublushMode() {
    saveDraft(Date.now()).then(() => {
      if (draftTitle.trim() === "") {
        alert("Please enter a title for your article.");
        return;
      } else if (draftContent.trim() === "") {
        alert("Please enter some content for your article.");
        return;
      } else if (draftTags.length < 1) {
        alert("Please enter at least one tag for your article.");
        return;
      }
      setPublishMode(true);
    });
  }

  async function publish() {
    setPublishing(true);
    const response = await fetch(props.publishUrl, {
      method: "POST",
      body: JSON.stringify({
        slug: slug ?? makeSlug(draftTitle),
        language: language ?? draftLanguage ?? "en",
      }),
      redirect: "manual",
    });
    if (response.status === 409) {
      alert(
        "An article with the same slug already exists. Please choose a different slug.",
      );
      setPublishing(false);
      slugInput.current?.focus();
      return;
    }
    const redirect = response.headers.get("Location");
    if (response.status !== 201 || redirect == null) {
      alert("Failed to publish the article. Please try again later.");
      setPublishing(false);
      return;
    }
    location.href = redirect;
  }

  const intl = new Intl.DisplayNames("en", { type: "language" });

  return (
    <div class={`flex ${props.class}`}>
      <div class={`basis-1/2 flex flex-col ${publishMode ? "hidden" : ""}`}>
        <div class="border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
          <input
            ref={titleInput}
            type="text"
            required
            placeholder="Article title"
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
          <textarea
            ref={contentTextArea}
            required
            placeholder="Write your article here. You can use Markdown."
            class="w-full h-full resize-none text-xl p-3 dark:bg-stone-900 dark:text-white border-4 border-transparent focus:border-stone-200 dark:focus:border-stone-700 focus:outline-none font-mono"
            onInput={onInput}
            value={content}
          />
        </div>
      </div>
      <div
        class={`basis-1/2 flex flex-col ${
          publishMode
            ? ""
            : "border-l-[1px] border-l-stone-300 dark:border-l-stone-600"
        }`}
      >
        {publishMode
          ? (
            <h1 class="text-2xl p-4 border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
              {draftTitle}
            </h1>
          )
          : (
            <div class="flex border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
              <TagInput
                class="grow"
                defaultTags={tags}
                onTagsChange={setTags}
              />
              <Button onClick={switchToPublushMode}>Publish</Button>
            </div>
          )}
        <div class="grow overflow-y-scroll p-4 text-xl">
          <div
            class="prose dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: previewHtml[0] }}
          />
        </div>
      </div>
      {publishMode &&
        (
          <div class="basis-1/2 flex flex-col border-l-[1px] border-l-stone-300 dark:border-l-stone-600">
            <div class="p-4">
              <PageTitle>Publish</PageTitle>
              <p>
                You're about to publish your article. Please review it before
                publishing.
              </p>
              <div class="flex flex-col gap-4 mt-4">
                <div>
                  <Label label="Slug">
                    <Input
                      ref={slugInput}
                      value={slug ?? makeSlug(draftTitle)}
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
                    This will be a part of the permalink of your article:<br />
                    <strong>
                      {new URL(
                        `./${new Date().getFullYear()}/${
                          slug ?? makeSlug(draftTitle)
                        }`,
                        props.publishUrlPrefix,
                      ).href}
                    </strong>
                  </p>
                </div>
                <div>
                  <Label label="Language">
                    <select
                      class="border-[1px] border-stone-500 p-2"
                      onInput={(event) =>
                        setLanguage(
                          (event.target as HTMLSelectElement).value,
                        )}
                    >
                      {languages
                        .map((lang) => [lang, intl.of(lang) ?? ""])
                        .toSorted(([_, a], [__, b]) =>
                          a < b ? -1 : a > b ? 1 : 0
                        )
                        .map(([lang, displayName]) => {
                          const nativeName = new Intl.DisplayNames(lang, {
                            type: "language",
                          })
                            .of(lang);
                          return (
                            <option
                              value={lang}
                              selected={(language ?? draftLanguage) === lang}
                            >
                              {nativeName != null && nativeName !== displayName
                                ? `${displayName} (${nativeName})`
                                : displayName}
                            </option>
                          );
                        })}
                    </select>
                  </Label>
                </div>
                <div class="flex w-full">
                  <div class="grow">
                    <Button
                      disabled={publishing}
                      onClick={() => setPublishMode(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                  <div class="text-right">
                    <Button disabled={publishing} onClick={publish}>
                      {publishing ? "Publishing now…" : "Publish now"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

function makeSlug(title: string): string {
  return slugify(title, { transliterate, strip: NON_ASCII });
}

// deno-fmt-ignore
const languages = [
  "aa", "ab", "ae", "af", "ak", "am", "an", "ar", "as", "av",
  "ay", "az", "ba", "be", "bg", "bh", "bi", "bm", "bn", "bo",
  "br", "bs", "ca", "ce", "ch", "co", "cr", "cs", "cu", "cv",
  "cy", "da", "de", "dv", "dz", "ee", "el", "en", "eo", "es",
  "et", "eu", "fa", "ff", "fi", "fj", "fo", "fr", "fy", "ga",
  "gd", "gl", "gn", "gu", "gv", "ha", "he", "hi", "ho", "hr",
  "ht", "hu", "hy", "hz", "ia", "id", "ie", "ig", "ii", "ik",
  "io", "is", "it", "iu", "ja", "jv", "ka", "kg", "ki", "kj",
  "kk", "kl", "km", "kn", "ko", "kr", "ks", "ku", "kv", "kw",
  "ky", "la", "lb", "lg", "li", "ln", "lo", "lt", "lu", "lv",
  "mg", "mh", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my",
  "na", "nb", "nd", "ne", "ng", "nl", "nn", "no", "nr", "nv",
  "ny", "oc", "oj", "om", "or", "os", "pa", "pi", "pl", "ps",
  "pt", "qu", "rm", "rn", "ro", "ru", "rw", "sa", "sc", "sd",
  "se", "sg", "si", "sk", "sl", "sm", "sn", "so", "sq", "sr",
  "ss", "st", "su", "sv", "sw", "ta", "te", "tg", "th", "ti",
  "tk", "tl", "tn", "to", "tr", "ts", "tt", "tw", "ty", "ug",
  "uk", "ur", "uz", "ve", "vi", "vo", "wa", "wo", "xh", "yi",
  "yo", "za", "zh", "zu",
]
