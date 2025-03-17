import { PostControls } from "../islands/PostControls.tsx";
import { getAvatarUrl } from "../models/actor.ts";
import { isPostVisibleTo } from "../models/post.ts";
import type {
  Account,
  Actor,
  Following,
  Mention,
  Post,
  PostMedium,
} from "../models/schema.ts";
import { ArticleExcerpt } from "./ArticleExcerpt.tsx";
import { Translation } from "./Msg.tsx";
import { NoteExcerpt } from "./NoteExcerpt.tsx";

export interface PostExcerptProps {
  class?: string;
  post: Post & {
    actor: Actor;
    sharedPost:
      | Post & {
        actor: Actor;
        replyTarget:
          | Post & {
            actor: Actor & { followers: Following[] };
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
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
      }
      | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
  };
  replyTarget?: boolean;
  noControls?: boolean;
  signedAccount?: Account & { actor: Actor };
}

export function PostExcerpt(props: PostExcerptProps) {
  const post = props.post.sharedPost ?? props.post;
  const sharer = props.post.sharedPost == null ? undefined : {
    url: props.post.actor.url ?? props.post.actor.iri,
    internalUrl: props.post.actor.accountId == null
      ? `/@${props.post.actor.username}@${props.post.actor.instanceHost}`
      : `/@${props.post.actor.username}`,
    name: props.post.actor.name ?? props.post.actor.username,
    emojis: props.post.actor.emojis,
    avatarUrl: getAvatarUrl(props.post.actor),
  };
  const localPostUrl = post.articleSourceId == null && post.noteSourceId == null
    ? `/@${post.actor.username}@${post.actor.instanceHost}/${post.id}`
    : `/@${post.actor.username}/${post.articleSourceId ?? post.noteSourceId}`;
  return (
    <Translation>
      {(_, language) => (
        <>
          {post.replyTarget != null &&
            isPostVisibleTo(post.replyTarget, props.signedAccount?.actor) && (
            <PostExcerpt
              post={{
                ...post.replyTarget,
                sharedPost: null,
                replyTarget: null,
                shares: [], // TODO: extract PostExcerpt from Post
              }}
              replyTarget
            />
          )}
          {post.type === "Article" || post.name != null
            ? (
              <ArticleExcerpt
                language={language}
                class={props.class}
                url={post.url ?? post.iri}
                target={post.actor.accountId == null ? "_blank" : undefined}
                title={post.name}
                contentHtml={post.contentHtml}
                emojis={post.emojis}
                lang={post.language ?? undefined}
                authorUrl={post.actor.url ?? post.actor.iri}
                authorInternalUrl={post.actor.accountId == null
                  ? `/@${post.actor.username}@${post.actor.instanceHost}`
                  : `/@${post.actor.username}`}
                authorName={post.actor.name ?? post.actor.username}
                authorHandle={`@${post.actor.username}@${post.actor.instanceHost}`}
                authorAvatarUrl={post.actor.avatarUrl}
                sharer={sharer}
                sharesCount={post.sharesCount}
                shared={props.signedAccount == null
                  ? false
                  : post.shares.some((s) =>
                    s.actorId === props.signedAccount!.actor.id
                  )}
                shareUrl={props.signedAccount == null
                  ? undefined
                  : post.articleSourceId == null
                  ? `/@${post.actor.username}@${post.actor.instanceHost}/${post.id}/share`
                  : `${post.url}/share`}
                unshareUrl={props.signedAccount == null
                  ? undefined
                  : post.articleSourceId == null
                  ? `/@${post.actor.username}@${post.actor.instanceHost}/${post.id}/unshare`
                  : `${post.url}/unshare`}
                published={post.published}
                repliesCount={post.repliesCount}
                replyUrl={post.articleSourceId == null
                  ? undefined
                  : `${post.url}#replies`}
                replyTarget={props.replyTarget}
                editUrl={post.articleSourceId == null ||
                    post.actorId !== props.signedAccount?.actor.id
                  ? null
                  : `${post.url}/edit`}
                deleteUrl={post.articleSourceId == null ||
                    post.actorId !== props.signedAccount?.actor.id
                  ? undefined
                  : `${post.url}/delete`}
              />
            )
            : (
              <>
                <NoteExcerpt
                  class={props.class}
                  url={post.url ?? post.iri}
                  internalUrl={post.noteSourceId == null
                    ? `/@${post.actor.username}@${post.actor.instanceHost}/${post.id}`
                    : `/@${post.actor.username}/${post.noteSourceId}`}
                  contentHtml={post.contentHtml}
                  emojis={post.emojis}
                  mentions={post.mentions}
                  lang={post.language ?? undefined}
                  visibility={post.visibility}
                  authorUrl={post.actor.url ?? post.actor.iri}
                  authorInternalUrl={post.actor.accountId == null
                    ? `/@${post.actor.username}@${post.actor.instanceHost}`
                    : `/@${post.actor.username}`}
                  authorName={post.actor.name ?? post.actor.username}
                  authorHandle={`@${post.actor.username}@${post.actor.instanceHost}`}
                  authorAvatarUrl={getAvatarUrl(post.actor)}
                  authorEmojis={post.actor.emojis}
                  sharer={sharer}
                  media={post.media}
                  published={post.published}
                  replyTarget={props.replyTarget}
                  reply={post.replyTarget != null}
                />
                {!props.replyTarget && !props.noControls && (
                  <PostControls
                    language={language}
                    class="mt-4 ml-14"
                    replies={post.repliesCount}
                    replyUrl={post.actor.accountId == null
                      ? `/@${post.actor.username}@${post.actor.instanceHost}/${post.id}#reply`
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
                    sharedPeopleUrl={post.noteSourceId == null
                      ? undefined
                      : `/@${post.actor.username}/${post.noteSourceId}/shares`}
                    deleteUrl={post.actor.accountId == null ||
                        post.actor.accountId !== props.signedAccount?.id
                      ? undefined
                      : `/@${post.actor.username}/${post.noteSourceId}`}
                  />
                )}
              </>
            )}
        </>
      )}
    </Translation>
  );
}
