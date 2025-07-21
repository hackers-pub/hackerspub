import { For, Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostCard_post$key } from "./__generated__/PostCard_post.graphql.ts";
import { PostCard } from "./PostCard.tsx";

export interface PostListProps {
  posts: PostCard_post$key[];
}

export function PostList(props: PostListProps) {
  const { t } = useLingui();
  return (
    <div class="border rounded-xl max-w-prose mx-auto my-4">
      <For each={props.posts}>
        {(post) => <PostCard $post={post} />}
      </For>
      <Show when={props.posts.length < 1}>
        <div class="px-4 py-8 text-center text-muted-foreground">
          {t`No posts found.`}
        </div>
      </Show>
    </div>
  );
}
