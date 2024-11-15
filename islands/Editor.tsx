import { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { TagInput } from "./TagInput.tsx";

export interface EditorProps {
  class?: string;
  previewUrl: string;
  draftUrl: string;
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
  const titleInput = useRef<HTMLInputElement | null>(null);
  const contentTextArea = useRef<HTMLTextAreaElement | null>(null);

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
      fetch(props.draftUrl, {
        method: "PUT",
        body: JSON.stringify({ title, content, tags }),
        headers: {
          "Content-Type": "application/json",
        },
      }).then(() => {
        setDraftTitle(title);
        setDraftContent(content);
        setDraftTags(tags);
        setDraftUpdated(now);
      });
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

  return (
    <div class={`flex ${props.class}`}>
      <div class="basis-1/2 flex flex-col">
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
            class="w-full h-full text-xl p-3 dark:bg-stone-900 dark:text-white border-4 border-transparent focus:border-stone-200 dark:focus:border-stone-700 focus:outline-none font-mono"
            onInput={onInput}
            value={content}
          />
        </div>
      </div>
      <div class="basis-1/2 flex flex-col border-l-[1px] border-l-stone-300 dark:border-l-stone-600">
        <div class="flex border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
          <TagInput class="grow" defaultTags={tags} onTagsChange={setTags} />
          <Button onClick={() => alert("Not implemented yet.")}>Publish</Button>
        </div>
        <div class="grow overflow-y-scroll p-4 text-xl">
          <div
            class="prose dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: previewHtml[0] }}
          />
        </div>
      </div>
    </div>
  );
}
