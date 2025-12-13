import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { PostAvatar_actor$key } from "./__generated__/PostAvatar_actor.graphql";
import { InternalLink } from "./InternalLink";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";

export interface PostAvatarProps {
  $actor: PostAvatar_actor$key;
}

export function PostAvatar(props: PostAvatarProps) {
  const actor = createFragment(
    graphql`
      fragment PostAvatar_actor on Actor {
        avatarUrl
        avatarInitials
        username
        handle
        local
        url
        iri
      }
    `,
    () => props.$actor,
  );

  return (
    <Show when={actor()}>
      {(a) => (
        <Avatar>
          <InternalLink
            href={a().url ?? a().iri}
            internalHref={a().local ? `/@${a().username}` : `/${a().handle}`}
          >
            <AvatarImage src={a().avatarUrl} />
            <AvatarFallback>{a().avatarInitials}</AvatarFallback>
          </InternalLink>
        </Avatar>
      )}
    </Show>
  );
}
