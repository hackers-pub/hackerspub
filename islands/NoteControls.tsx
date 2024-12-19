import { TranslationSetup } from "../components/Msg.tsx";
import getFixedT from "../i18n.ts";
import { Language } from "../i18n.ts";

export interface NoteControlsProps {
  language: Language;
  class?: string;
  replies: number;
  replyUrl?: string;
}

export function NoteControls(props: NoteControlsProps) {
  const t = getFixedT(props.language);
  return (
    <TranslationSetup language={props.language}>
      <div class={`${props.class ?? ""}`}>
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
      </div>
    </TranslationSetup>
  );
}
