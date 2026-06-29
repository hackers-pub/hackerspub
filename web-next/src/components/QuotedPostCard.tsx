import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { QuotedNoteCard } from "~/components/QuotedNoteCard.tsx";
import type { QuotedPostCard_post$key } from "./__generated__/QuotedPostCard_post.graphql.ts";

const quotedNoteCardTypenames = new Set(["Note", "Question", "Article"]);

export interface QuotedPostCardProps {
  readonly $post: QuotedPostCard_post$key;
  readonly quotePostId?: string;
  readonly canRevokeQuote?: boolean;
  readonly linkPreview?: boolean;
  readonly class?: string;
  readonly classList?: { [k: string]: boolean | undefined };
}

export function QuotedPostCard(props: QuotedPostCardProps) {
  const post = createFragment(
    graphql`
      fragment QuotedPostCard_post on Post {
        __typename
        ...QuotedNoteCard_post
      }
    `,
    () => props.$post,
  );

  return (
    <Show keyed when={post()}>
      {(post) => (
        <Show when={quotedNoteCardTypenames.has(post.__typename)}>
          <QuotedNoteCard
            $post={post}
            quotePostId={props.quotePostId}
            canRevokeQuote={props.canRevokeQuote}
            linkPreview={props.linkPreview}
            class={props.class}
            classList={props.classList}
          />
        </Show>
      )}
    </Show>
  );
}
