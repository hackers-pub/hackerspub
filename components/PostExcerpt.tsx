import type { Actor, Post } from "../models/schema.ts";
import { ArticleExcerpt } from "./ArticleExcerpt.tsx";
import { NoteExcerpt } from "./NoteExcerpt.tsx";

export interface PostExcerptProps {
  class?: string;
  post: Post & { actor: Actor };
}

export function PostExcerpt(props: PostExcerptProps) {
  const { post } = props;
  return post.type === "Article" || post.name != null
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
      />
    )
    : (
      <NoteExcerpt
        class={props.class}
        url={post.url ?? post.iri}
        contentHtml={post.contentHtml}
        lang={post.language ?? undefined}
        visibility={post.visibility}
        authorUrl={post.actor.url ?? post.actor.iri}
        authorName={post.actor.name ?? post.actor.username}
        authorHandle={`@${post.actor.username}@${post.actor.instanceHost}`}
        authorAvatarUrl={post.actor.avatarUrl}
        published={post.published}
      />
    );
}
