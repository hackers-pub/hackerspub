import { getAvatarUrl } from "@hackerspub/models/avatar";
import { renderCustomEmojis } from "@hackerspub/models/emoji";
import type { Account, Actor, Post, Reaction } from "@hackerspub/models/schema";
import { escape } from "@std/html/entities";
import { useEffect, useState } from "preact/hooks";
import { Excerpt } from "../components/Excerpt.tsx";
import { Msg, TranslationSetup } from "../components/Msg.tsx";
import type { Language } from "../i18n.ts";
import { ArticleMetadata } from "./ArticleMetadata.tsx";
import { Link } from "./Link.tsx";
import { PostControls } from "./PostControls.tsx";

interface ArticleExcerptProps {
  language: Language;
  post: Post & {
    actor: Actor;
    reactions: Reaction[];
    shares: Post[];
  };
  replier?: Actor | null;
  sharer?: Actor | null;
  controls?: boolean;
  class?: string;
  signedAccount:
    | Account & {
      actor: Actor;
    }
    | undefined
    | null;
}

export function ArticleExcerpt(props: ArticleExcerptProps) {
  const { post, replier, sharer, language } = props;
  const [content, setContent] = useState<
    {
      title: string | null;
      summary: string | null;
      language: string | null;
      originalLanguage: string | null;
    }
  >({
    title: post.name,
    summary: post.summary,
    language: post.language,
    originalLanguage: null,
  });
  const [contentLoaded, setContentLoaded] = useState(false);
  useEffect(() => {
    if (contentLoaded || post.articleSourceId == null) return;
    fetch(`/api/articles/${post.articleSourceId}/content`)
      .then((res) => res.json())
      .then((data) => setContent(data))
      .finally(() => setContentLoaded(true));
  });
  const remotePost = post.articleSourceId == null && post.noteSourceId == null;
  return (
    <TranslationSetup language={language}>
      <article
        class={`
            mt-5 p-5 bg-stone-100 dark:bg-stone-800
            ${props.class}
          `}
      >
        {replier != null && (
          <p class="text-stone-500 dark:text-stone-400 mb-2">
            <Msg
              $key="article.replied"
              name={
                <Link
                  href={replier.url ?? replier.iri}
                  internalHref={replier.accountId == null
                    ? `/${replier.handle}`
                    : `/@${replier.username}`}
                  class="font-bold"
                >
                  <img
                    src={getAvatarUrl(replier)}
                    width={16}
                    height={16}
                    class="inline-block mr-1 mt-[2px] align-text-top"
                  />
                  {replier.name == null
                    ? <strong>{replier.username}</strong>
                    : (
                      <strong
                        dangerouslySetInnerHTML={{
                          __html: renderCustomEmojis(
                            escape(replier.name),
                            replier.emojis,
                          ),
                        }}
                      />
                    )}
                </Link>
              }
            />
          </p>
        )}
        {sharer != null && (
          <p class="text-stone-500 dark:text-stone-400 mb-2">
            <Msg
              $key="article.shared"
              name={
                <Link
                  href={sharer.url ?? sharer.iri}
                  internalHref={sharer.accountId == null
                    ? `/${sharer.handle}`
                    : `/@${sharer.username}`}
                  class="font-bold"
                >
                  <img
                    src={getAvatarUrl(sharer)}
                    width={16}
                    height={16}
                    class="inline-block mr-1 mt-[2px] align-text-top"
                  />
                  {sharer.name == null
                    ? <strong>{sharer.username}</strong>
                    : (
                      <strong
                        dangerouslySetInnerHTML={{
                          __html: renderCustomEmojis(
                            escape(sharer.name),
                            sharer.emojis,
                          ),
                        }}
                      />
                    )}
                </Link>
              }
            />
          </p>
        )}
        {content.title != null &&
          (
            <h1
              class="text-3xl font-bold mb-2"
              lang={content.language ?? undefined}
            >
              <a
                href={content.language == null ||
                    content.originalLanguage == null
                  ? post.url ?? post.iri
                  : `${post.url ?? post.iri}/${content.language}`}
                target={remotePost ? "_blank" : undefined}
              >
                {content.title}
              </a>
            </h1>
          )}
        <ArticleMetadata
          language={language}
          class="mt-4 mb-2"
          authorUrl={post.actor.url ?? post.actor.iri}
          authorInternalUrl={post.actor.accountId == null
            ? `/${post.actor.handle}`
            : `/@${post.actor.username}`}
          authorName={post.actor.name == null ? post.actor.username : (
            <span
              dangerouslySetInnerHTML={{
                __html: renderCustomEmojis(
                  escape(post.actor.name),
                  post.actor.emojis,
                ),
              }}
            />
          )}
          authorHandle={post.actor.handle}
          authorAvatarUrl={getAvatarUrl(post.actor)}
          published={post.published}
          editUrl={post.actorId === props.signedAccount?.actor.id
            ? `${post.url}/edit`
            : null}
          deleteUrl={post.actorId === props.signedAccount?.actor.id
            ? `${post.url}/delete`
            : null}
        />
        <a
          href={content.language == null ||
              content.originalLanguage == null
            ? post.url ?? post.iri
            : `${post.url ?? post.iri}/${content.language}`}
          target={remotePost ? "_blank" : undefined}
        >
          {content.summary == null
            ? (
              <Excerpt
                lang={post.language}
                html={post.contentHtml}
                emojis={post.emojis}
              />
            )
            : (
              <p
                lang={content.language ?? undefined}
                class="prose dark:prose-invert leading-8"
              >
                {content.summary}
              </p>
            )}
          <Msg $key="article.readMore" />
        </a>
        {props.controls && (
          <PostControls
            language={language}
            post={props.post}
            class="mt-4"
            signedAccount={props.signedAccount}
          />
        )}
      </article>
    </TranslationSetup>
  );
}
