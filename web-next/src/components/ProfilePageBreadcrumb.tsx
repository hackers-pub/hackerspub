import { graphql } from "relay-runtime";
import { ComponentProps, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { InternalLink } from "~/components/InternalLink.tsx";
import { TopBreadcrumb } from "~/components/TopBreadcrumb.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { ProfilePageBreadcrumb_actor$key } from "./__generated__/ProfilePageBreadcrumb_actor.graphql.ts";

export interface ProfilePageBreadcrumbProps extends ComponentProps<"ol"> {
  $actor: ProfilePageBreadcrumb_actor$key;
}

export function ProfilePageBreadcrumb(props: ProfilePageBreadcrumbProps) {
  const actor = createFragment(
    graphql`
      fragment ProfilePageBreadcrumb_actor on Actor {
        name
        local
        username
        handle
        url
        iri
      }
    `,
    () => props.$actor,
  );

  return (
    <Show when={actor()}>
      {(actor) => (
        <TopBreadcrumb>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <Show
              when={props.children == null ||
                Array.isArray(props.children) && props.children.length < 1}
              fallback={
                <BreadcrumbLink
                  as={InternalLink}
                  href={actor().url ?? actor().iri}
                  internalHref={actor().local
                    ? `/@${actor().username}`
                    : `/${actor().handle}`}
                >
                  <span innerHTML={actor().name ?? actor().username} />
                </BreadcrumbLink>
              }
            >
              <BreadcrumbLink current>
                <span innerHTML={actor().name ?? actor().username} />
              </BreadcrumbLink>
            </Show>
          </BreadcrumbItem>
          {props.children}
        </TopBreadcrumb>
      )}
    </Show>
  );
}
