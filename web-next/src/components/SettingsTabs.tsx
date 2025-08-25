import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { SettingsTabs_account$key } from "./__generated__/SettingsTabs_account.graphql.ts";

export type SettingsTab = "profile" | "preferences" | "passkeys";

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
    <Show when={account()}>
      {(account) => (
        <Tabs value={props.selected}>
          <TabsList class="grid max-w-prose mx-auto grid-cols-3">
            <TabsTrigger
              as={A}
              value="profile"
              href={`/@${account().username}/settings`}
            >
              {t`Profile settings`}
            </TabsTrigger>
            <TabsTrigger
              as={A}
              value="preferences"
              href={`/@${account().username}/settings/preferences`}
            >
              {t`Preferences`}
            </TabsTrigger>
            <TabsTrigger
              as={A}
              value="passkeys"
              href={`/@${account().username}/settings/passkeys`}
            >
              {t`Passkeys`}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
    </Show>
  );
}
