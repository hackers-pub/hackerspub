import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import type { ArticleControls_article$key } from "./__generated__/ArticleControls_article.graphql.ts";
import { BookmarkButton } from "./BookmarkButton.tsx";

export interface ArticleControlsProps {
  $article: ArticleControls_article$key;
  connections?: string[];
  class?: string;
}

export function ArticleControls(props: ArticleControlsProps) {
  const article = createFragment(
    graphql`
      fragment ArticleControls_article on Article {
        ...BookmarkButton_post
      }
    `,
    () => props.$article,
  );

  return (
    <Show when={article()}>
      {(a) => (
        <div
          class={`flex items-center justify-end gap-1 px-2 py-1 border-t ${
            props.class ?? ""
          }`}
        >
          <BookmarkButton $post={a()} connections={props.connections} />
        </div>
      )}
    </Show>
  );
}
