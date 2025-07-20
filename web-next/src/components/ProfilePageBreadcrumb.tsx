import { graphql } from "relay-runtime";
import { ComponentProps, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { ProfilePageBreadcrumb_account$key } from "./__generated__/ProfilePageBreadcrumb_account.graphql.ts";
import { TopBreadcrumb } from "./TopBreadcrumb.tsx";
import { Badge } from "./ui/badge.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "./ui/breadcrumb.tsx";

export interface ProfilePageBreadcrumbProps extends ComponentProps<"ol"> {
  $account: ProfilePageBreadcrumb_account$key;
}

export function ProfilePageBreadcrumb(props: ProfilePageBreadcrumbProps) {
  const account = createFragment(
    graphql`
      fragment ProfilePageBreadcrumb_account on Account {
        name
        username
        handle
      }
    `,
    () => props.$account,
  );

  return (
    <Show when={account()}>
      {(account) => (
        <TopBreadcrumb>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink
              current={props.children == null ||
                Array.isArray(props.children) && props.children.length < 1}
              href={props.children == null ||
                  Array.isArray(props.children) && props.children.length < 1
                ? undefined
                : `/@${account().username}`}
            >
              {account().name}{" "}
              <Badge variant="secondary" class="select-all">
                {account().handle}
              </Badge>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {props.children}
        </TopBreadcrumb>
      )}
    </Show>
  );
}
