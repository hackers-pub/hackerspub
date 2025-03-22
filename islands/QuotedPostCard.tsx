import { escape } from "@std/html/entities";
import { useEffect, useState } from "preact/hooks";
import { TranslationSetup } from "../components/Msg.tsx";
import { PostVisibilityIcon } from "../components/PostVisibilityIcon.tsx";
import type { Language } from "../i18n.ts";
import { getAvatarUrl } from "../models/avatar.ts";
import { renderCustomEmojis } from "../models/emoji.ts";
import { preprocessContentHtml } from "../models/html.ts";
import type { Actor, ArticleSource, Mention, Post } from "../models/schema.ts";
import type { Uuid } from "../models/uuid.ts";
import { Link } from "./Link.tsx";
import { Timestamp } from "./Timestamp.tsx";

export interface QuotedPostCardProps {
  language: Language;
  id: Uuid;
  class?: string | null;
}

type PostObject = Post & {
  actor: Actor;
  articleSource: ArticleSource | null;
  mentions: (Mention & { actor: Actor })[];
};

export function QuotedPostCard(props: QuotedPostCardProps) {
  const [post, setPost] = useState<PostObject | null>(null);
  useEffect(() => {
    fetch(`/api/posts/${props.id}`)
      .then((response) => response.text())
      .then((data) =>
        setPost(JSON.parse(data, (k, v) => k === "published" ? new Date(v) : v))
      );
  }, [post]);
  return (
    <TranslationSetup language={props.language}>
      <div
        class={`
        block border
        border-stone-300 bg-stone-100 dark:border-stone-700 dark:bg-stone-800
        hover:border-stone-400 hover:bg-stone-200
        dark:hover:border-stone-500 dark:hover:bg-stone-700
        ${props.class ?? ""}
        ${post == null ? "cursor-wait" : ""}
      `}
      >
        {post == null
          ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              stroke="currentColor"
              fill="currentColor"
              className="size-8 mx-auto my-8"
            >
              <style>
                {`.spinner_P7sC{transform-origin:center;animation:spinner_svv2 .75s infinite linear}@keyframes spinner_svv2{100%{transform:rotate(360deg)}}`}
              </style>
              <path
                d="M10.14,1.16a11,11,0,0,0-9,8.92A1.59,1.59,0,0,0,2.46,12,1.52,1.52,0,0,0,4.11,10.7a8,8,0,0,1,6.66-6.61A1.42,1.42,0,0,0,12,2.69h0A1.57,1.57,0,0,0,10.14,1.16Z"
                class="spinner_P7sC"
              />
            </svg>
          )
          : (
            <Link
              class="block p-4"
              href={post.url ?? post.iri}
              internalHref={post.noteSourceId
                ? `/@${post.actor.username}/${post.noteSourceId}`
                : post.articleSource
                ? `/@${post.actor.username}/${post.articleSource.publishedYear}/${post.articleSource.slug}`
                : `/@${post.actor.username}@${post.actor.instanceHost}/${post.id}`}
            >
              <div class="flex gap-2">
                <img src={getAvatarUrl(post.actor)} width={48} height={48} />
                <div class="flex flex-col">
                  <p>
                    {post.actor.name == null
                      ? <strong>{post.actor.username}</strong>
                      : (
                        <strong
                          dangerouslySetInnerHTML={{
                            __html: renderCustomEmojis(
                              escape(post.actor.name),
                              post.actor.emojis,
                            ),
                          }}
                        >
                        </strong>
                      )}
                    <span class="
                    ml-1 before:content-['('] after:content-[')']
                    text-stone-500 dark:text-stone-400
                  ">
                      @{post.actor.username}@{post.actor.instanceHost}
                    </span>
                  </p>
                  <p class="flex flex-wrap sm:flex-nowrap text-stone-500 dark:text-stone-400">
                    <span class="after:content-['_·'] mr-1">
                      <Timestamp
                        value={post.published}
                        locale={props.language}
                      />
                    </span>
                    <PostVisibilityIcon visibility={post.visibility} />
                  </p>
                </div>
              </div>
              {post.summary && (
                <p class="my-2 text-stone-500 dark:text-stone-400 font-bold">
                  {post.summary}
                </p>
              )}
              <div
                class={`
                mt-2 ml-14 prose dark:prose-invert break-words overflow-wrap
                ${post.sensitive ? "blur-md hover:blur-0 transition-all" : ""}
              `}
                dangerouslySetInnerHTML={{
                  __html: preprocessContentHtml(
                    post.contentHtml,
                    post.mentions,
                    post.emojis ?? {},
                  ),
                }}
              />
              {post.quotedPostId && (
                <QuotedPostCard
                  language={props.language}
                  id={post.quotedPostId}
                  class="mt-4 ml-14"
                />
              )}
            </Link>
          )}
      </div>
    </TranslationSetup>
  );
}
