import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { SettingsTabs_account$key } from "./__generated__/SettingsTabs_account.graphql.ts";

export type SettingsTab =
  | "profile"
  | "preferences"
  | "language"
  | "invite"
  | "passkeys"
  | "blocks";

export interface SettingsTabsProps {
  selected: SettingsTab;
  $account: SettingsTabs_account$key;
}

export function SettingsTabs(props: SettingsTabsProps) {
  const { t } = useLingui();
  const account = createFragment(
    graphql`
      fragment SettingsTabs_account on Account {
        username
      }
    `,
    () => props.$account,
  );

  return (
    <Show keyed when={account()}>
      {(account) => (
        <Tabs value={props.selected}>
          <div class="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList class="min-w-full justify-start">
              <TabsTrigger
                as={A}
                value="profile"
                href={`/@${account.username}/settings`}
                class="shrink-0"
              >
                {t`Profile settings`}
              </TabsTrigger>
              <TabsTrigger
                as={A}
                value="preferences"
                href={`/@${account.username}/settings/preferences`}
                class="shrink-0"
              >
                {t`Preferences`}
              </TabsTrigger>
              <TabsTrigger
                as={A}
                value="language"
                href={`/@${account.username}/settings/language`}
                class="shrink-0"
              >
                {t`Language settings`}
              </TabsTrigger>
              <TabsTrigger
                as={A}
                value="invite"
                href={`/@${account.username}/settings/invite`}
                class="shrink-0"
              >
                {t`Invite`}
              </TabsTrigger>
              <TabsTrigger
                as={A}
                value="passkeys"
                href={`/@${account.username}/settings/passkeys`}
                class="shrink-0"
              >
                {t`Passkeys`}
              </TabsTrigger>
              <TabsTrigger
                as={A}
                value="blocks"
                href={`/@${account.username}/settings/blocks`}
                class="shrink-0"
              >
                {t`Mutes and blocks`}
              </TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      )}
    </Show>
  );
}
