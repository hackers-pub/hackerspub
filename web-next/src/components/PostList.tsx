import { For } from "solid-js";
import { PostCard_post$key } from "./__generated__/PostCard_post.graphql.ts";
import { PostCard } from "./PostCard.tsx";

export interface PostListProps {
  posts: PostCard_post$key[];
}

export function PostList(props: PostListProps) {
  return (
    <div class="border rounded-xl max-w-prose mx-auto my-4">
      <For each={props.posts}>
        {(post) => <PostCard $post={post} />}
      </For>
    </div>
  );
}
