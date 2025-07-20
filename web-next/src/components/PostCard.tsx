import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { PostCard_post$key } from "./__generated__/PostCard_post.graphql.ts";
import { NoteCard } from "./NoteCard.tsx";

export interface PostCardProps {
  $post: PostCard_post$key;
}

export function PostCard(props: PostCardProps) {
  const post = createFragment(
    graphql`
      fragment PostCard_post on Post {
        __typename
        ...NoteCard_note
      }
    `,
    () => props.$post,
  );

  return (
    <Show when={post()}>
      {(post) => (
        <Show when={post().__typename === "Note"}>
          <NoteCard $note={post()} />
        </Show>
      )}
    </Show>
  );
}
