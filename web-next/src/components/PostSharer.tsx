import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostSharer_post$key } from "./__generated__/PostSharer_post.graphql.ts";
import { Timestamp } from "./Timestamp.tsx";
import { Trans } from "./Trans.tsx";

export interface PostSharerProps {
  $post: PostSharer_post$key;
  class?: string;
}

export function PostSharer(props: PostSharerProps) {
  const { t } = useLingui();
  const post = createFragment(
    graphql`
      fragment PostSharer_post on Post {
        actor {
          name
          local
          username
          handle
        }
        published
      }
    `,
    () => props.$post,
  );

  return (
    <Show when={post()}>
      {(post) => (
        <p class={`text-sm text-muted-foreground ${props.class ?? ""}`}>
          <Trans
            message={t`${"SHARER"} shared ${"RELATIVE_TIME"}`}
            values={{
              SHARER: () => (
                <a
                  href={`/${
                    post().actor.local
                      ? `@${post().actor.username}`
                      : post().actor.handle
                  }`}
                  class="font-semibold"
                >
                  {post().actor.name}
                </a>
              ),
              RELATIVE_TIME: () => <Timestamp value={post().published} />,
            }}
          />
        </p>
      )}
    </Show>
  );
}
