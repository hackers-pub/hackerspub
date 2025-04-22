import { escape } from "@std/html/entities";
import { Link } from "../islands/Link.tsx";
import { MediumThumbnail } from "../islands/MediumThumbnail.tsx";
import { PollCard } from "../islands/PollCard.tsx";
import { QuotedPostCard } from "../islands/QuotedPostCard.tsx";
import { Timestamp } from "../islands/Timestamp.tsx";
import { getAvatarUrl } from "../models/avatar.ts";
import { renderCustomEmojis } from "../models/emoji.ts";
import { preprocessContentHtml } from "../models/html.ts";
import type {
  Account,
  Actor,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "../models/schema.ts";
import { Msg, Translation } from "./Msg.tsx";
import { PostVisibilityIcon } from "./PostVisibilityIcon.tsx";

export interface NoteExcerptProps {
  class?: string;
  post: Post & {
    actor: Actor;
    reactions: Reaction[];
    shares: Post[];
    mentions: (Mention & { actor: Actor })[];
    link: PostLink & { creator?: Actor | null } | null;
    media: PostMedium[];
  };
  sharer?: Actor | null;
  replyTarget?: boolean;
  reply?: boolean;
  signedAccount?: Account & { actor: Actor };
}

export function NoteExcerpt(props: NoteExcerptProps) {
  const { post } = props;
  return (
    <Translation>
      {(_, lang) => (
        <article
          class={`${props.reply ? "" : "mt-5"} flex flex-col ${
            props.class ?? ""
          }`}
        >
          <div class={`flex gap-2 ${props.replyTarget ? "opacity-55" : ""}`}>
            <Link
              href={post.actor.url ?? post.actor.iri}
              internalHref={post.actor.accountId == null
                ? `/${post.actor.handle}`
                : `/@${post.actor.username}`}
              class="w-12 h-12"
            >
              <img
                src={getAvatarUrl(post.actor)}
                width={48}
                height={48}
                class="inline-block mr-2 align-text-bottom"
              />
            </Link>
            <div class="flex flex-col wrap-anywhere">
              <Link
                href={post.actor.url ?? post.actor.iri}
                internalHref={post.actor.accountId == null
                  ? `/${post.actor.handle}`
                  : `/@${post.actor.username}`}
              >
                {post.actor.name == null
                  ? <strong class="break-keep">{post.actor.username}</strong>
                  : (
                    <strong
                      class="text-black dark:text-white break-keep"
                      dangerouslySetInnerHTML={{
                        __html: renderCustomEmojis(
                          escape(post.actor.name),
                          post.actor.emojis,
                        ),
                      }}
                    />
                  )}{" "}
                <span class="text-stone-500 dark:text-stone-400 select-all before:content-['('] after:content-[')']">
                  {post.actor.handle}
                </span>
              </Link>
              <div class="flex flex-wrap sm:flex-nowrap text-stone-500 dark:text-stone-400">
                <Link
                  href={post.url ?? post.iri}
                  internalHref={post.noteSourceId == null
                    ? `/${post.actor.handle}/${post.id}`
                    : `/@${post.actor.username}/${post.noteSourceId}`}
                  class="after:content-['_·'] mr-1"
                >
                  <Timestamp value={post.published} locale={lang} />
                </Link>
                <PostVisibilityIcon
                  class="inline-block"
                  visibility={post.visibility}
                />
                {props.sharer && (
                  <span class="w-full sm:w-auto sm:before:content-['·_'] sm:ml-1">
                    <Msg
                      $key="note.sharedBy"
                      name={
                        <Link
                          href={props.sharer.url ?? props.sharer.iri}
                          internalHref={props.sharer.accountId == null
                            ? `/${props.sharer.handle}`
                            : `/@${props.sharer.username}`}
                        >
                          <img
                            src={getAvatarUrl(props.sharer)}
                            width={16}
                            height={16}
                            class="inline-block mr-1 mt-[2px] align-text-top"
                          />
                          {props.sharer.name == null
                            ? <strong>{props.sharer.username}</strong>
                            : (
                              <strong
                                dangerouslySetInnerHTML={{
                                  __html: renderCustomEmojis(
                                    escape(props.sharer.name),
                                    props.sharer.emojis,
                                  ),
                                }}
                              />
                            )}
                        </Link>
                      }
                    />
                  </span>
                )}
              </div>
            </div>
          </div>
          <div
            class={`
              ${props.replyTarget ? "opacity-55" : ""}
              ${
              props.replyTarget
                ? "ml-6 pl-7 border-stone-400 dark:border-stone-600 border-l-4"
                : "ml-14"
            }
            `}
            lang={post.language ?? undefined}
          >
            {post.summary != null && (
              <p class="my-2 text-stone-500 dark:text-stone-400 font-bold">
                {post.summary}
              </p>
            )}
            <div
              class={`
                mt-2 prose dark:prose-invert break-words overflow-wrap
                ${post.sensitive ? "blur-md hover:blur-0 transition-all" : ""}
              `}
              dangerouslySetInnerHTML={{
                __html: preprocessContentHtml(
                  post.contentHtml,
                  { ...post, quote: post.quotedPostId != null },
                ),
              }}
            />
            {post.type === "Question" &&
              (
                <PollCard
                  language={lang}
                  postId={post.id}
                  signedAccount={props.signedAccount}
                  class="mt-4"
                />
              )}
            {post.media.length < 1 && post.quotedPostId == null &&
              post.link && (
              <div class="mt-4">
                <a
                  href={post.linkUrl ?? post.link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={`
                    border border-stone-300
                    bg-stone-100 dark:border-stone-700 dark:bg-stone-800
                    max-w-prose
                    ${
                    post.link.imageUrl == null ||
                      post.link.imageWidth != null &&
                        post.link.imageHeight != null &&
                        post.link.imageWidth / post.link.imageHeight > 1.5
                      ? "block"
                      : "flex items-center"
                  }
                  `}
                >
                  {post.link.imageUrl && post.link.imageWidth != null &&
                    post.link.imageHeight != null &&
                    post.link.imageWidth / post.link.imageHeight > 1.5 &&
                    (
                      <img
                        src={post.link.imageUrl}
                        alt={post.link.imageAlt ?? undefined}
                        width={post.link.imageWidth ?? undefined}
                        height={post.link.imageHeight ?? undefined}
                        class="w-full h-auto"
                      />
                    )}
                  {post.link.imageUrl && (post.link.imageWidth == null ||
                    post.link.imageHeight == null ||
                    post.link.imageWidth / post.link.imageHeight <= 1.5) &&
                    (
                      <img
                        src={post.link.imageUrl}
                        alt={post.link.imageAlt ?? undefined}
                        width={post.link.imageWidth ?? undefined}
                        height={post.link.imageHeight ?? undefined}
                        class="max-h-40 w-auto"
                      />
                    )}
                  <div>
                    <p class="m-4 font-bold">{post.link.title}</p>
                    {(post.link.description ||
                      post.link.author && !URL.canParse(post.link.author)) && (
                      <p class="m-4 text-stone-500 dark:text-stone-400 line-clamp-2">
                        {post.link.author && (
                          <>
                            <span class="font-bold">{post.link.author}</span>
                            {post.link.description && " · "}
                          </>
                        )}
                        {post.link.description}
                      </p>
                    )}
                    <p class="m-4">
                      <span class="text-stone-500 dark:text-stone-400 uppercase">
                        {new URL(post.link.url).host}
                      </span>
                      {post.link.siteName && (
                        <>
                          <span class="text-stone-500 dark:text-stone-400">
                            {" · "}
                          </span>
                          <span class="text-stone-500 dark:text-stone-400 font-bold">
                            {post.link.siteName}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                </a>
                {post.link.creator && (
                  <p class="max-w-prose p-4 bg-stone-300 dark:bg-stone-700 text-stone-700 dark:text-stone-300">
                    <Msg
                      $key="note.linkAuthor"
                      author={
                        <Link
                          href={post.link.creator.url ??
                            post.link.creator.iri}
                          internalHref={post.link.creator.accountId == null
                            ? `/${post.link.creator.handle}`
                            : `/@${post.link.creator.username}`}
                          class="font-bold text-stone-950 dark:text-stone-50"
                        >
                          {post.link.creator.avatarUrl && (
                            <img
                              src={post.link.creator.avatarUrl}
                              class="inline-block size-5 mr-1 align-text-top"
                            />
                          )}
                          <span
                            dangerouslySetInnerHTML={{
                              __html: post.link.creator.name == null
                                ? post.link.creator.username
                                : renderCustomEmojis(
                                  escape(post.link.creator.name),
                                  post.link.creator.emojis,
                                ),
                            }}
                          />
                          <span class="opacity-50 before:content-['_('] after:content-[')'] font-normal">
                            {post.link.creator.handle}
                          </span>
                        </Link>
                      }
                    />
                  </p>
                )}
              </div>
            )}
          </div>
          {post.media.length > 0 && (
            <div
              class={`
              flex [justify-center:safe_center] lg:justify-center w-full overflow-x-auto
              ${
                props.replyTarget
                  ? `
                    before:content-['.'] before:absolute before:w-1 before:left-[40px] before:xl:left-[calc((100%-1280px)/2+40px)]
                    before:opacity-55 before:bg-gradient-to-b before:from-stone-400 dark:before:from-stone-600 before:to-transparent
                    before:text-transparent
                  `
                  : ""
              }
            `}
            >
              {post.media.map((medium) => (
                <MediumThumbnail
                  key={medium.index}
                  medium={medium}
                  class={`
                    ${props.replyTarget ? "opacity-55" : ""}
                    ${
                    post.sensitive || medium.sensitive
                      ? "my-20 blur-2xl hover:blur-0 transition-all"
                      : ""
                  }
                  `}
                />
              ))}
            </div>
          )}
          {post.quotedPostId != null &&
            (
              <div
                class={`
                  ml-14
                  ${
                  props.replyTarget && post.media.length < 1
                    ? `
                      mb-2
                      before:content-['.'] before:absolute before:w-1 before:left-[40px] before:xl:left-[calc((100%-1280px)/2+40px)]
                      before:opacity-55 before:bg-gradient-to-b before:from-stone-400 dark:before:from-stone-600 before:to-transparent
                      before:text-transparent before:min-h-28
                      `
                    : ""
                }
                `}
              >
                <QuotedPostCard
                  id={post.quotedPostId}
                  language={lang}
                  class={`
                    mt-4 mb-2
                    ${props.replyTarget ? "opacity-55" : ""}
                  `}
                />
              </div>
            )}
        </article>
      )}
    </Translation>
  );
}
