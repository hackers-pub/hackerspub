import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import type { PostExcerpt_post$key } from "./__generated__/PostExcerpt_post.graphql.ts";
import { Excerpt } from "./Excerpt.tsx";

interface PostExcerptProps {
  $post: PostExcerpt_post$key;
}

export function PostExcerpt(props: PostExcerptProps) {
  const post = createFragment(
    graphql`
      fragment PostExcerpt_post on Post {
        url
        content
        iri
        language
      }
    `,
    () => props.$post,
  );

  return (
    <Show when={post()}>
      {(post) => (
        <a
          href={post().url ?? post().iri}
          class="block mt-4 p-3 bg-stone-50 dark:bg-stone-900 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
        >
          <Excerpt
            html={post().content}
            lang={post().language}
          />
        </a>
      )}
    </Show>
  );
}
