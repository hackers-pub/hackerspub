import { NoteControls } from "../islands/NoteControls.tsx";
import { getAvatarUrl } from "../models/actor.ts";
import type { Actor, Post } from "../models/schema.ts";
import { ArticleExcerpt } from "./ArticleExcerpt.tsx";
import { Translation } from "./Msg.tsx";
import { NoteExcerpt } from "./NoteExcerpt.tsx";

export interface PostExcerptProps {
  class?: string;
  post: Post & { actor: Actor; replyTarget: Post & { actor: Actor } | null };
  replyTarget?: boolean;
  signedIn?: boolean;
}

export function PostExcerpt(props: PostExcerptProps) {
  const { post } = props;
  return (
    <Translation>
      {(_, language) => (
        <>
          {post.replyTarget != null && (
            <PostExcerpt
              post={{ ...post.replyTarget, replyTarget: null }}
              replyTarget={true}
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
                lang={post.language ?? undefined}
                authorUrl={post.actor.url ?? post.actor.iri}
                authorName={post.actor.name ?? post.actor.username}
                authorHandle={`@${post.actor.username}@${post.actor.instanceHost}`}
                authorAvatarUrl={post.actor.avatarUrl}
                published={post.published}
                replyTarget={props.replyTarget}
              />
            )
            : (
              <>
                <NoteExcerpt
                  class={props.class}
                  url={post.url ?? post.iri}
                  contentHtml={post.contentHtml}
                  lang={post.language ?? undefined}
                  visibility={post.visibility}
                  authorUrl={post.actor.url ?? post.actor.iri}
                  authorName={post.actor.name ?? post.actor.username}
                  authorHandle={`@${post.actor.username}@${post.actor.instanceHost}`}
                  authorAvatarUrl={getAvatarUrl(post.actor)}
                  published={post.published}
                  replyTarget={props.replyTarget}
                  reply={props.post.replyTarget != null}
                />
                {!props.replyTarget && props.signedIn && (
                  <NoteControls
                    language={language}
                    class="mt-4 ml-14"
                    replies={post.repliesCount}
                    replyUrl={post.actor.accountId == null
                      ? `/@${post.actor.username}@${post.actor.instanceHost}/${post.id}#reply`
                      : `/@${post.actor.username}/${post.noteSourceId}#reply`}
                  />
                )}
              </>
            )}
        </>
      )}
    </Translation>
  );
}
