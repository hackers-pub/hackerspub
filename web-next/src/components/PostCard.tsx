import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { PostCard_post$key } from "./__generated__/PostCard_post.graphql.ts";
import { ArticleCard } from "./ArticleCard.tsx";
import { NoteCard } from "./NoteCard.tsx";

export interface PostCardProps {
  $post: PostCard_post$key;
}

export function PostCard(props: PostCardProps) {
  const post = createFragment(
    graphql`
      fragment PostCard_post on Post
        @argumentDefinitions(
          locale: { type: "Locale" },
        )
      {
        __typename
        ...NoteCard_note
        ...ArticleCard_article @arguments(locale: $locale)
      }
    `,
    () => props.$post,
  );

  return (
    <Show when={post()}>
      {(post) => (
        <Switch>
          <Match when={post().__typename === "Note"}>
            <NoteCard $note={post()} />
          </Match>
          <Match when={post().__typename === "Article"}>
            <ArticleCard $article={post()} />
          </Match>
        </Switch>
      )}
    </Show>
  );
}
