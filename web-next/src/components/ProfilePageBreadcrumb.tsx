import { graphql } from "relay-runtime";
import { ComponentProps, Show } from "solid-js";
import { createFragment } from "solid-relay";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { ProfilePageBreadcrumb_actor$key } from "./__generated__/ProfilePageBreadcrumb_actor.graphql.ts";
import { TopBreadcrumb } from "./TopBreadcrumb.tsx";

export interface ProfilePageBreadcrumbProps extends ComponentProps<"ol"> {
  $actor: ProfilePageBreadcrumb_actor$key;
}

export function ProfilePageBreadcrumb(props: ProfilePageBreadcrumbProps) {
  const actor = createFragment(
    graphql`
      fragment ProfilePageBreadcrumb_actor on Actor {
        name
        username
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
            <BreadcrumbLink
              current={props.children == null ||
                Array.isArray(props.children) && props.children.length < 1}
              href={props.children == null ||
                  Array.isArray(props.children) && props.children.length < 1
                ? undefined
                : `/@${actor().username}`}
            >
              <span innerHTML={actor().name ?? actor().username} />
            </BreadcrumbLink>
          </BreadcrumbItem>
          {props.children}
        </TopBreadcrumb>
      )}
    </Show>
  );
}
