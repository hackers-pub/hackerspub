import { graphql } from "relay-runtime";
import { ComponentProps, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
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
  const { t } = useLingui();
  const account = createFragment(
    graphql`
      fragment ProfilePageBreadcrumb_account on Account {
        name
        handle
      }
    `,
    () => props.$account,
  );

  return (
    <Show when={account()}>
      {(account) => (
        <TopBreadcrumb>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">{t`Home`}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink current>
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
