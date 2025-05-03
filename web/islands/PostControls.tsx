import {
  isReactionEmoji,
  REACTION_EMOJIS,
  type ReactionEmoji,
} from "@hackerspub/models/emoji";
import type { Account, Actor, Post, Reaction } from "@hackerspub/models/schema";
import { useState } from "preact/hooks";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";
import getFixedT from "../i18n.ts";

export interface PostControlsProps {
  language: Language;
  active?: "reply" | "quote" | "reactions";
  signedAccount: Account & { actor: Actor } | undefined | null;
  post: Post & { actor: Actor; reactions: Reaction[]; shares: Post[] };
  class?: string;
}

export type ReactionState = "reacted" | "reacting" | "undoing" | undefined;

export function PostControls(props: PostControlsProps) {
  const { post, signedAccount } = props;
  const t = getFixedT(props.language);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [reactionStates, setReactionStates] = useState(
    toReactionStates(signedAccount, post.reactions),
  );
  const [reactionsCounts, setReactionsCounts] = useState(post.reactionsCounts);
  const [shares, setShares] = useState(post.sharesCount);
  const [shared, setShared] = useState(
    signedAccount != null &&
      post.shares.some((share) => share.actorId === signedAccount?.actor.id),
  );
  const [shareSubmitting, setShareSubmitting] = useState(false);
  const [shareFocused, setShareFocused] = useState(false);
  const [deleted, setDeleted] = useState<null | "deleting" | "deleted">(null);
  const nonPrivate = post.visibility === "public" ||
    post.visibility === "unlisted";
  const remotePost = post.articleSourceId == null && post.noteSourceId == null;
  const localPostUrl = remotePost
    ? `/${post.actor.handle}/${post.id}`
    : `${post.url}`;

  let anyReacted = false;
  for (const emoji of REACTION_EMOJIS) {
    if (reactionStates[emoji] === "reacted") {
      anyReacted = true;
      break;
    }
  }
  let totalReactions = 0;
  let etcReactions = 0;
  for (const emoji in reactionsCounts) {
    totalReactions += reactionsCounts[emoji];
    if (!isReactionEmoji(emoji)) etcReactions += reactionsCounts[emoji];
  }

  function onReactionsClick(event: MouseEvent) {
    event.preventDefault();
    setReactionsOpen(!reactionsOpen);
  }

  function onEmojiReactionClick(event: MouseEvent) {
    event.preventDefault();
    const span = event.currentTarget;
    if (!(span instanceof HTMLElement)) return;
    const emoji = span.dataset.emoji as ReactionEmoji;
    if (
      reactionStates[emoji] === "reacting" ||
      reactionStates[emoji] === "undoing"
    ) {
      return;
    }
    setReactionStates((prev) => ({
      ...prev,
      emoji: prev[emoji] == null ? "reacting" : "undoing",
    }));
    fetch(`${localPostUrl}/react`, {
      method: "post",
      body: JSON.stringify({
        mode: reactionStates[emoji] == null ? "react" : "undo",
        emoji,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    }).then((response) => {
      if (response.ok) {
        setReactionsCounts((prev) => ({
          ...prev,
          [emoji]: (prev[emoji] ?? 0) +
            (reactionStates[emoji] == null ? 1 : -1),
        }));
        setReactionStates((prev) => ({
          ...prev,
          [emoji]: prev[emoji] === "reacting" || prev[emoji] == null
            ? "reacted"
            : undefined,
        }));
      }
    });
  }

  function onShareSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (!nonPrivate) return;
    if (event.currentTarget instanceof HTMLFormElement) {
      setShareSubmitting(true);
      const form = event.currentTarget;
      fetch(form.action, { method: form.method })
        .then((response) => {
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

  function onDelete(this: HTMLButtonElement, _event: MouseEvent) {
    if (
      post.actorId !== signedAccount?.actor.id ||
      !confirm(t("post.deleteConfirm"))
    ) {
      return;
    }
    setDeleted("deleting");
    fetch(
      post.articleSourceId == null ? localPostUrl : `${localPostUrl}/delete`,
      { method: post.articleSourceId == null ? "delete" : "post" },
    )
      .then((response) => {
        if (response.status >= 200 && response.status < 400) {
          setDeleted("deleted");
        }
      });
  }

  const shareableExternally = navigator.clipboard != null ||
    navigator.share != null;
  function onShareExternally() {
    if (navigator.share) {
      navigator.share({
        title: t("post.shareExternally.title", {
          actor: `${post.actor.name}(${post.actor.handle})`,
        }),
        url: localPostUrl,
      });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(t("post.shareExternally.fullText", {
        actor: `${post.actor.name}(${post.actor.handle})`,
        url: localPostUrl,
      })).then(() => {
        alert(t("clipboard.copied"));
      });
    }
  }

  return (
    <TranslationSetup language={props.language}>
      <div class={`${props.class ?? ""} flex`}>
        <a
          class={`
            h-5 mr-3 flex hover:opacity-100 cursor-pointer
            ${reactionsOpen ? "opacity-100" : "opacity-50"}
          `}
          href={remotePost ? undefined : `${localPostUrl}/reactions`}
          title={t("post.reactions.title")}
          onClick={onReactionsClick}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className={`
              size-5
              ${reactionsOpen || anyReacted ? "stroke-2" : ""}
            `}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"
            />
          </svg>
          <span
            class={`
              ml-1 my-auto text-xs
              ${reactionsOpen || anyReacted ? "font-bold" : ""}
            `}
          >
            {totalReactions.toLocaleString(props.language)}
            {!reactionsOpen && anyReacted && (
              <>
                {" "}&mdash; <Msg $key="post.reacted" />
              </>
            )}
          </span>
        </a>
        <div class={`${reactionsOpen ? "flex" : "hidden"} gap-3`}>
          {REACTION_EMOJIS.map((emoji) => (
            <span
              key={emoji}
              data-emoji={emoji}
              onClick={onEmojiReactionClick}
              class="text-xs my-auto group cursor-pointer"
            >
              <span class="grayscale-[75%] group-hover:grayscale-0">
                {emoji}
              </span>
              <span
                class={`
                  ml-1 opacity-50 group-hover:opacity-100
                  ${reactionStates[emoji] === "reacted" ? "font-bold" : ""}
                `}
              >
                {(reactionsCounts[emoji] ?? 0).toLocaleString(
                  props.language,
                )}
                {reactionStates[emoji] != null && (
                  <>
                    {" "}&mdash;{" "}
                    <Msg
                      $key={reactionStates[emoji] === "reacting"
                        ? "post.reacting"
                        : reactionStates[emoji] === "undoing"
                        ? "post.undoingReaction"
                        : "post.reacted"}
                    />
                  </>
                )}
              </span>
            </span>
          ))}
        </div>
        {!remotePost &&
          (
            <a
              href={`${localPostUrl}/reactions`}
              class={`
            ${reactionsOpen ? "flex" : "hidden"}
            h-5 ml-1 opacity-50 hover:opacity-100 cursor-pointer
          `}
              title={t("post.reactions.stats")}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="size-5"
                aria-label={t("post.reactions.stats")}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z"
                />
              </svg>
              <span class="my-auto text-xs">
                {etcReactions.toLocaleString(props.language)}
              </span>
            </a>
          )}
        <div class={`${reactionsOpen ? "hidden" : "flex"} gap-3`}>
          <a
            class={`
              h-5 flex
              ${props.active === "reply" ? "opacity-100" : "opacity-50"}
              ${deleted != null ? "" : "hover:opacity-100"}
            `}
            href={localPostUrl}
            title={t("note.replies")}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className={`size-5 ${props.active === "reply" ? "stroke-2" : ""}`}
              aria-label={t("note.replies")}
            >
              <path d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 0 1-.923 1.785A5.969 5.969 0 0 0 6 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337Z" />
            </svg>
            <span
              class={`ml-1 my-auto text-xs ${
                props.active === "reply" ? "font-bold" : ""
              }`}
            >
              {post.repliesCount.toLocaleString(props.language)}
            </span>
          </a>
          <form
            method="post"
            action={nonPrivate
              ? shared ? `${localPostUrl}/unshare` : `${localPostUrl}/share`
              : undefined}
            onSubmit={onShareSubmit}
          >
            <button
              type="submit"
              class={`
                h-5 flex opacity-50
                ${deleted != null ? "cursor-default" : "hover:opacity-100"}
              `}
              onMouseOver={onShareFocus}
              onFocus={onShareFocus}
              onMouseOut={onShareFocusOut}
              onBlur={onShareFocusOut}
              title={t("note.shares")}
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
                <path d="m19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662m-.092 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662m-11.908 0-3-3-3 3m21-6-3 3-3-3" />
              </svg>
              <span
                class={`ml-1 my-auto text-xs ${shared ? "font-bold" : ""}`}
              >
                {(shared ? Math.max(shares, 1) : shares).toLocaleString(
                  props.language,
                )}
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
          {nonPrivate && (
            <a
              href={`${localPostUrl}/quotes`}
              class={`
                h-5 flex hover:opacity-100
                ${props.active === "quote" ? "opacity-100" : "opacity-50"}
              `}
              title={t("post.quotes")}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                className={`size-5 ${
                  props.active === "quote" ? "stroke-2" : ""
                }`}
                aria-label={t("post.quotes")}
              >
                <path d="M4 9v-1a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1h4a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2v2l-2-2h-6a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h4m0 6v1a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-4m-2 2l2-2l2 2" />
                <path stroke-linecap="round" d="M13 12v.01m3 0v-.01m3 0v.01" />
              </svg>
              <span
                class={`ml-1 my-auto text-xs ${
                  props.active === "quote" ? "font-bold" : ""
                }`}
              >
                {post.quotesCount.toLocaleString(props.language)}
              </span>
            </a>
          )}
          {!remotePost && (
            <a
              class={`
                h-5 flex
                ${props.active === "reactions" ? "opacity-100" : "opacity-50"}
                ${deleted != null ? "" : "hover:opacity-100"}
              `}
              href={`${localPostUrl}/reactions`}
              title={t("post.reactions.stats")}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className={`size-5 ${
                  props.active === "reactions" ? "stroke-2" : ""
                }`}
                aria-label={t("post.reactions.stats")}
              >
                <path d="M9.348 14.652a3.75 3.75 0 0 1 0-5.304m5.304 0a3.75 3.75 0 0 1 0 5.304m-7.425 2.121a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788M12 12h.008v.008H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
              </svg>
            </a>
          )}
          {shareableExternally && (
            <button
              type="button"
              class="h-5 flex opacity-50 hover:opacity-100"
              title={t("post.shareExternally.action")}
              onClick={onShareExternally}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                class="size-5"
                aria-label={t("post.shareExternally.action")}
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"
                />
              </svg>
            </button>
          )}
          {signedAccount?.actor.id === post.actorId &&
            (
              <button
                type="button"
                class={`
                  h-5 flex opacity-50
                  ${deleted != null ? "cursor-default" : "hover:opacity-100"}
                `}
                title={t("post.delete")}
                onClick={onDelete}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className={`size-5 ${
                    deleted === "deleted" ? "stroke-2" : ""
                  }`}
                  aria-label={t("post.delete")}
                >
                  <path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
                {deleted != null &&
                  (
                    <span
                      class={`ml-1 my-auto text-xs ${
                        deleted === "deleted" ? "font-bold" : ""
                      }`}
                    >
                      {" — "}
                      <Msg
                        $key={deleted === "deleted"
                          ? "post.deleted"
                          : "post.deleting"}
                      />
                    </span>
                  )}
              </button>
            )}
        </div>
      </div>
    </TranslationSetup>
  );
}

function toReactionStates(
  account: Account & { actor: Actor } | undefined | null,
  reactions: Reaction[],
): Record<ReactionEmoji, ReactionState> {
  if (account == null) {
    return Object.fromEntries(
      REACTION_EMOJIS.map((e) => [e, undefined] as const),
    ) as Record<ReactionEmoji, ReactionState>;
  }
  return Object.fromEntries(
    reactions
      .filter((r) => r.actorId === account.actor.id)
      .map((r) => [r.emoji, "reacted"]),
  );
}
