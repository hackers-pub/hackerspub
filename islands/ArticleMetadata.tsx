import { Msg, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";
import getFixedT from "../i18n.ts";
import { Link } from "./Link.tsx";
import { Timestamp } from "./Timestamp.tsx";

export interface ArticleMetadataProps {
  language: Language;
  class?: string;
  authorUrl: string;
  authorInternalUrl?: string | null;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl?: string | null;
  published: Date;
  editUrl?: string | null;
  deleteUrl?: string | null;
}

export function ArticleMetadata(props: ArticleMetadataProps) {
  const t = getFixedT(props.language);

  function onDelete(this: HTMLFormElement, event: SubmitEvent) {
    if (!confirm(t("article.deleteConfirm"))) {
      event.preventDefault();
      return;
    }
  }

  return (
    <TranslationSetup language={props.language}>
      <div
        class={`flex flex-row text-stone-500 dark:text-stone-400 truncate ${props.class}`}
      >
        <Link
          href={props.authorUrl}
          internalHref={props.authorInternalUrl ?? undefined}
          class="block size-12 shrink-0 mr-2"
        >
          {props.authorAvatarUrl && (
            <img
              src={props.authorAvatarUrl}
              width={48}
              height={48}
              class="block size-12"
            />
          )}
        </Link>
        <div class="flex flex-col">
          <p>
            <Link
              href={props.authorUrl}
              internalHref={props.authorInternalUrl ?? undefined}
              class="font-bold text-black dark:text-white"
            >
              {props.authorName}
            </Link>{" "}
            <span class="select-all before:content-['('] after:content-[')']">
              {props.authorHandle}
            </span>
          </p>
          <form
            action={props.deleteUrl ?? undefined}
            method="post"
            onSubmit={onDelete}
          >
            <Timestamp value={props.published} locale={props.language} />
            {props.editUrl && (
              <>
                {" "}
                &middot;{" "}
                <a href={props.editUrl}>
                  <Msg $key="article.edit" />
                </a>
              </>
            )}
            {props.deleteUrl && (
              <>
                {" "}
                &middot;{" "}
                <button type="submit">
                  <Msg $key="article.delete" />
                </button>
              </>
            )}
          </form>
        </div>
        {" "}
      </div>
    </TranslationSetup>
  );
}
