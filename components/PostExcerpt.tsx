import { PostControls } from "../islands/PostControls.tsx";
import { getAvatarUrl } from "../models/actor.ts";
import { isPostVisibleTo } from "../models/post.ts";
import type {
  Account,
  Actor,
  Following,
  Mention,
  Post,
  PostLink,
  PostMedium,
} from "../models/schema.ts";
import { ArticleExcerpt } from "./ArticleExcerpt.tsx";
import { Translation } from "./Msg.tsx";
import { NoteExcerpt } from "./NoteExcerpt.tsx";

export interface PostExcerptProps {
  class?: string;
  post: Post & {
    actor: Actor;
    link: PostLink & { creator?: Actor | null } | null;
    sharedPost:
      | Post & {
        actor: Actor;
        link: PostLink & { creator?: Actor | null } | null;
        replyTarget:
          | Post & {
            actor: Actor & { followers: Following[] };
            link: PostLink & { creator?: Actor | null } | null;
            mentions: (Mention & { actor: Actor })[];
            media: PostMedium[];
          }
          | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
        shares: Post[];
      }
      | null;
    replyTarget:
      | Post & {
        actor: Actor & { followers: Following[] };
        link: PostLink & { creator?: Actor | null } | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
      }
      | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
  };
  replier?: {
    url: string;
    internalUrl?: string;
    name: string;
    emojis: Record<string, string>;
    avatarUrl: string;
  };
  noControls?: boolean;
  noQuote?: boolean;
  signedAccount?: Account & { actor: Actor };
}

export function PostExcerpt(props: PostExcerptProps) {
  const post = props.post.sharedPost ?? props.post;
  const sharer = props.post.sharedPost == null ? undefined : {
    url: props.post.actor.url ?? props.post.actor.iri,
    internalUrl: props.post.actor.accountId == null
      ? `/${props.post.actor.handle}`
      : `/@${props.post.actor.username}`,
    name: props.post.actor.name ?? props.post.actor.username,
    emojis: props.post.actor.emojis,
    avatarUrl: getAvatarUrl(props.post.actor),
  };
  const localPostUrl = post.articleSourceId == null && post.noteSourceId == null
    ? `/${post.actor.handle}/${post.id}`
    : `/@${post.actor.username}/${post.articleSourceId ?? post.noteSourceId}`;
  const replyTarget = post.replyTarget != null &&
      isPostVisibleTo(
        post.replyTarget,
        props.signedAccount?.actor,
      )
    ? post.replyTarget
    : null;
  return (
    <Translation>
      {(_, language) => (
        <>
          {replyTarget != null &&
            isPostVisibleTo(replyTarget, props.signedAccount?.actor) && (
            <PostExcerpt
              post={{
                ...replyTarget,
                sharedPost: null,
                replyTarget: null,
                shares: [], // TODO: extract PostExcerpt from Post
              }}
              replier={{
                url: post.actor.url ?? post.actor.iri,
                internalUrl: post.actor.accountId == null
                  ? `/${post.actor.handle}`
                  : `/@${post.actor.username}`,
                name: post.actor.name ?? post.actor.username,
                emojis: post.actor.emojis,
                avatarUrl: getAvatarUrl(post.actor),
              }}
            />
          )}
          {post.type === "Article" || post.name != null
            ? (
              <ArticleExcerpt
                class={props.class}
                url={post.url ?? post.iri}
                target={post.actor.accountId == null ? "_blank" : undefined}
                title={post.name}
                contentHtml={post.contentHtml}
                emojis={post.emojis}
                lang={post.language ?? undefined}
                authorUrl={post.actor.url ?? post.actor.iri}
                authorInternalUrl={post.actor.accountId == null
                  ? `/${post.actor.handle}`
                  : `/@${post.actor.username}`}
                authorName={post.actor.name ?? post.actor.username}
                authorHandle={post.actor.handle}
                authorAvatarUrl={post.actor.avatarUrl}
                sharer={sharer}
                published={post.published}
                replier={props.replier}
                editUrl={post.articleSourceId == null ||
                    post.actorId !== props.signedAccount?.actor.id
                  ? null
                  : `${post.url}/edit`}
                deleteUrl={post.articleSourceId == null ||
                    post.actorId !== props.signedAccount?.actor.id
                  ? undefined
                  : `${post.url}/delete`}
                controls={props.replier ? undefined : {
                  repliesCount: post.repliesCount,
                  replyUrl: post.articleSourceId == null
                    ? undefined
                    : `${post.url}#replies`,
                  sharesCount: post.sharesCount,
                  shared: props.signedAccount == null
                    ? false
                    : post.shares.some((s) =>
                      s.actorId === props.signedAccount!.actor.id
                    ),
                  shareUrl: props.signedAccount == null
                    ? undefined
                    : post.articleSourceId == null
                    ? `/${post.actor.handle}/${post.id}/share`
                    : `${post.url}/share`,
                  unshareUrl: props.signedAccount == null
                    ? undefined
                    : post.articleSourceId == null
                    ? `/${post.actor.handle}/${post.id}/unshare`
                    : `${post.url}/unshare`,
                  sharedPeopleUrl: post.articleSourceId == null
                    ? undefined
                    : `${post.url}/shares`,
                }}
              />
            )
            : (
              <div
                class={replyTarget?.type === "Article"
                  ? "bg-gradient-to-b from-stone-100 dark:from-stone-800 to-transparent flex flex-row p-4 pt-0 gap-4"
                  : ""}
              >
                {replyTarget?.type === "Article" && (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="1.5"
                    stroke="currentColor"
                    class="size-6"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="m16.49 12 3.75 3.75m0 0-3.75 3.75m3.75-3.75H3.74V4.499"
                    />
                  </svg>
                )}
                <div>
                  <NoteExcerpt
                    class={replyTarget?.type != "Article"
                      ? `${props.class} mt-2`
                      : props.class}
                    url={post.url ?? post.iri}
                    internalUrl={post.noteSourceId == null
                      ? `/${post.actor.handle}/${post.id}`
                      : `/@${post.actor.username}/${post.noteSourceId}`}
                    sensitive={post.sensitive}
                    summary={post.summary ?? undefined}
                    contentHtml={post.contentHtml}
                    emojis={post.emojis}
                    mentions={post.mentions}
                    lang={post.language ?? undefined}
                    visibility={post.visibility}
                    link={post.link ?? undefined}
                    linkUrl={post.linkUrl ?? undefined}
                    authorUrl={post.actor.url ?? post.actor.iri}
                    authorInternalUrl={post.actor.accountId == null
                      ? `/${post.actor.handle}`
                      : `/@${post.actor.username}`}
                    authorName={post.actor.name ?? post.actor.username}
                    authorHandle={post.actor.handle}
                    authorAvatarUrl={getAvatarUrl(post.actor)}
                    authorEmojis={post.actor.emojis}
                    quotedPostId={props.noQuote
                      ? undefined
                      : (post.quotedPostId ?? undefined)}
                    sharer={sharer}
                    media={post.media}
                    published={post.published}
                    replyTarget={props.replier != null}
                    reply={replyTarget != null}
                  />
                  {!props.replier && !props.noControls && (
                    <PostControls
                      language={language}
                      class="mt-4 ml-14"
                      replies={post.repliesCount}
                      replyUrl={post.actor.accountId == null
                        ? `/${post.actor.handle}/${post.id}#reply`
                        : `/@${post.actor.username}/${post.noteSourceId}#reply`}
                      shares={post.sharesCount}
                      shareUrl={props.signedAccount == null ||
                          !["public", "unlisted"].includes(post.visibility)
                        ? undefined
                        : `${localPostUrl}/share`}
                      unshareUrl={props.signedAccount == null ||
                          !["public", "unlisted"].includes(post.visibility)
                        ? undefined
                        : `${localPostUrl}/unshare`}
                      shared={post.shares.some((share) =>
                        share.actorId === props.signedAccount?.actor.id
                      )}
                      reactionsUrl={post.noteSourceId == null
                        ? undefined
                        : `/@${post.actor.username}/${post.noteSourceId}/shares`}
                      deleteUrl={post.actor.accountId == null ||
                          post.actor.accountId !== props.signedAccount?.id
                        ? undefined
                        : `/@${post.actor.username}/${post.noteSourceId}`}
                    />
                  )}
                </div>
              </div>
            )}
        </>
      )}
    </Translation>
  );
}
