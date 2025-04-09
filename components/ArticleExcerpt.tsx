import { escape } from "@std/html/entities";
import { ArticleMetadata } from "../islands/ArticleMetadata.tsx";
import { Link } from "../islands/Link.tsx";
import { PostControls } from "../islands/PostControls.tsx";
import { getAvatarUrl } from "../models/avatar.ts";
import { renderCustomEmojis } from "../models/emoji.ts";
import type { Account, Actor, Post, Reaction } from "../models/schema.ts";
import { Excerpt } from "./Excerpt.tsx";
import { Msg, Translation } from "./Msg.tsx";

interface ArticleExcerptProps {
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
  const { post, replier, sharer } = props;
  const remotePost = post.articleSourceId == null && post.noteSourceId == null;
  return (
    <Translation>
      {(_, language) => (
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
          {post.name != null &&
            (
              <h1
                class="text-3xl font-bold mb-2"
                lang={post.language ?? undefined}
              >
                <a
                  href={post.url ?? post.iri}
                  target={remotePost ? "_blank" : undefined}
                >
                  {post.name}
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
            href={post.url ?? post.iri}
            target={remotePost ? "_blank" : undefined}
          >
            <Excerpt
              lang={post.language}
              html={post.contentHtml}
              emojis={post.emojis}
            />
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
      )}
    </Translation>
  );
}
