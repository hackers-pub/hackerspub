import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { ActorSharerActor } from "./ActorSharer.tsx";
import { PostCard_post$key } from "./__generated__/PostCard_post.graphql.ts";
import { ArticleCard } from "./ArticleCard.tsx";
import { NoteCard } from "./NoteCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";

export interface PostCardProps {
  $post: PostCard_post$key;
  sharerActor?: ActorSharerActor | null;
  sharerTimestamp?: string | null;
  connections?: string[];
  bookmarkListConnections?: string[];
  pinConnections?: string[];
  deferHeavySections?: boolean;
  onDeleted?: () => void;
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
        ...QuestionCard_question
      }
    `,
    () => props.$post,
  );

  return (
    <Show keyed when={post()}>
      {(post) => (
        <Switch>
          <Match when={post.__typename === "Note"}>
            <NoteCard
              $note={post}
              sharerActor={props.sharerActor}
              sharerTimestamp={props.sharerTimestamp}
              connections={props.connections}
              bookmarkListConnections={props.bookmarkListConnections}
              pinConnections={props.pinConnections}
              deferHeavySections={props.deferHeavySections}
              onDeleted={props.onDeleted}
            />
          </Match>
          <Match when={post.__typename === "Article"}>
            <ArticleCard
              $article={post}
              sharerActor={props.sharerActor}
              sharerTimestamp={props.sharerTimestamp}
              connections={props.connections}
              bookmarkListConnections={props.bookmarkListConnections}
              pinConnections={props.pinConnections}
              deferHeavySections={props.deferHeavySections}
            />
          </Match>
          <Match when={post.__typename === "Question"}>
            <QuestionCard
              $question={post}
              sharerActor={props.sharerActor}
              sharerTimestamp={props.sharerTimestamp}
              connections={props.connections}
              bookmarkListConnections={props.bookmarkListConnections}
              pinConnections={props.pinConnections}
              deferHeavySections={props.deferHeavySections}
              onDeleted={props.onDeleted}
            />
          </Match>
        </Switch>
      )}
    </Show>
  );
}
