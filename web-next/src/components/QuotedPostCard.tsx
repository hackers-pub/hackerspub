import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { QuotedNoteCard } from "~/components/QuotedNoteCard.tsx";
import type { QuotedPostCard_post$key } from "./__generated__/QuotedPostCard_post.graphql.ts";

export interface QuotedPostCardProps {
  readonly $post: QuotedPostCard_post$key;
  readonly quotePostId?: string;
  readonly canRevokeQuote?: boolean;
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
        <Switch>
          <Match when={post.__typename === "Note"}>
            <QuotedNoteCard
              $post={post}
              quotePostId={props.quotePostId}
              canRevokeQuote={props.canRevokeQuote}
              class={props.class}
              classList={props.classList}
            />
          </Match>
          <Match when={post.__typename === "Question"}>
            <QuotedNoteCard
              $post={post}
              quotePostId={props.quotePostId}
              canRevokeQuote={props.canRevokeQuote}
              class={props.class}
              classList={props.classList}
            />
          </Match>
          <Match when={post.__typename === "Article"}>
            <QuotedNoteCard
              $post={post}
              quotePostId={props.quotePostId}
              canRevokeQuote={props.canRevokeQuote}
              class={props.class}
              classList={props.classList}
            />
          </Match>
        </Switch>
      )}
    </Show>
  );
}
