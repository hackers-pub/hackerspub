import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ProfileTabs_actor$key } from "./__generated__/ProfileTabs_actor.graphql.ts";

export type ProfileTab =
  | "posts"
  | "notes"
  | "articles"
  | "shares"
  | "interactions";

export interface ProfileTabsProps {
  selected: ProfileTab;
  $actor: ProfileTabs_actor$key;
}

export function ProfileTabs(props: ProfileTabsProps) {
  const { t } = useLingui();
  const viewer = useViewer();
  const actor = createFragment(
    graphql`
      fragment ProfileTabs_actor on Actor
        @argumentDefinitions(actingAccountId: { type: "ID", defaultValue: null })
      {
        handle
        isViewer(actingAccountId: $actingAccountId)
        local
        username
        viewerBlocks(actingAccountId: $actingAccountId)
        blocksViewer(actingAccountId: $actingAccountId)
      }
    `,
    () => props.$actor,
  );

  return (
    <Show keyed when={actor()}>
      {(actor) => {
        const baseUrl = () =>
          actor.local ? `/@${actor.username}` : `/${actor.handle}`;
        return (
          <Show when={!actor.viewerBlocks && !actor.blocksViewer}>
            <Tabs value={props.selected}>
              <TabsList class="flex max-w-full justify-start overflow-x-auto">
                <TabsTrigger
                  as={A}
                  value="posts"
                  href={baseUrl()}
                  class="shrink-0"
                >
                  {t`Posts`}
                </TabsTrigger>
                <TabsTrigger
                  as={A}
                  value="notes"
                  href={`${baseUrl()}/notes`}
                  class="shrink-0"
                >
                  {t`Notes`}
                </TabsTrigger>
                <TabsTrigger
                  as={A}
                  value="articles"
                  href={`${baseUrl()}/articles`}
                  class="shrink-0"
                >
                  {t`Articles`}
                </TabsTrigger>
                <TabsTrigger
                  as={A}
                  value="shares"
                  href={`${baseUrl()}/shares`}
                  class="shrink-0"
                >
                  {t`Shares`}
                </TabsTrigger>
                <Show when={viewer.isAuthenticated() && !actor.isViewer}>
                  <TabsTrigger
                    as={A}
                    value="interactions"
                    href={`${baseUrl()}/interactions`}
                    class="shrink-0"
                  >
                    {t`Interactions`}
                  </TabsTrigger>
                </Show>
              </TabsList>
            </Tabs>
          </Show>
        );
      }}
    </Show>
  );
}
