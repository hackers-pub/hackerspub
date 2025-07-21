import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ProfileTabs_actor$key } from "./__generated__/ProfileTabs_actor.graphql.ts";

export type ProfileTab = "posts" | "notes" | "articles";

export interface ProfileTabsProps {
  selected: ProfileTab;
  $actor: ProfileTabs_actor$key;
}

export function ProfileTabs(props: ProfileTabsProps) {
  const { t } = useLingui();
  const actor = createFragment(
    graphql`
      fragment ProfileTabs_actor on Actor {
        handle
        account {
          username
        }
      }
    `,
    () => props.$actor,
  );

  return (
    <Show when={actor()}>
      {(actor) => {
        const account = actor().account;
        const baseUrl = account == null
          ? `/${actor().handle}`
          : `/@${account.username}`;
        return (
          <Tabs value={props.selected}>
            <TabsList class="grid max-w-prose mx-auto grid-cols-3">
              <TabsTrigger as={A} value="posts" href={baseUrl}>
                {t`Posts`}
              </TabsTrigger>
              <TabsTrigger as={A} value="notes" href={`${baseUrl}/notes`}>
                {t`Notes`}
              </TabsTrigger>
              <TabsTrigger as={A} value="articles" href={`${baseUrl}/articles`}>
                {t`Articles`}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        );
      }}
    </Show>
  );
}
