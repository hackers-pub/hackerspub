import { useState } from "preact/hooks";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";
import getFixedT from "../i18n.ts";

export interface NoteControlsProps {
  language: Language;
  class?: string;
  replies: number;
  replyUrl?: string;
  shares: number;
  shared: boolean;
  shareUrl: string;
  unshareUrl: string;
}

export function NoteControls(props: NoteControlsProps) {
  const t = getFixedT(props.language);
  const [shares, setShares] = useState(props.shares);
  const [shared, setShared] = useState(props.shared);
  const [shareSubmitting, setShareSubmitting] = useState(false);
  const [shareFocused, setShareFocused] = useState(false);

  function onShareSubmit(this: HTMLButtonElement, event: SubmitEvent) {
    event.preventDefault();
    if (event.currentTarget instanceof HTMLFormElement) {
      setShareSubmitting(true);
      const form = event.currentTarget;
      fetch(form.action, { method: form.method })
        .then((response) => {
          console.debug(response);
          if (response.status >= 200 && response.status < 400) {
            setShared(!shared);
            setShareSubmitting(false);
            setShares(shares + (shared ? -1 : 1));
          }
        });
    }
  }

  function onShareFocus() {
    setShareFocused(true);
  }

  function onShareFocusOut() {
    setShareFocused(false);
  }

  return (
    <TranslationSetup language={props.language}>
      <div class={`${props.class ?? ""} flex gap-3`}>
        <a
          class="h-5 flex opacity-50 hover:opacity-100"
          href={props.replyUrl}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="size-5"
            aria-label={t("note.replies")}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 0 1-.923 1.785A5.969 5.969 0 0 0 6 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337Z"
            />
          </svg>
          <span class="ml-1 my-auto text-xs">
            {props.replies.toLocaleString(props.language)}
          </span>
        </a>
        <form
          method="post"
          action={shared ? props.unshareUrl : props.shareUrl}
          onSubmit={onShareSubmit}
        >
          <button
            type="submit"
            class="h-5 flex opacity-50 hover:opacity-100"
            onMouseOver={onShareFocus}
            onFocus={onShareFocus}
            onMouseOut={onShareFocusOut}
            onBlur={onShareFocusOut}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className={`size-5 ${shared ? "stroke-2" : ""}`}
              aria-label={t("note.shares")}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"
              />
            </svg>
            <span
              class={`ml-1 my-auto text-xs ${shared ? "font-bold" : ""}`}
            >
              {shares.toLocaleString(props.language)}
              {(shared || shareSubmitting) && (
                <>
                  {" "}&mdash;{" "}
                  <Msg
                    $key={shareSubmitting
                      ? (shared ? "note.unsharing" : "note.sharing")
                      : shareFocused
                      ? "note.unshare"
                      : "note.shared"}
                  />
                </>
              )}
            </span>
          </button>
        </form>
      </div>
    </TranslationSetup>
  );
}
