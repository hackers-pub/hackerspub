import { Msg } from "./Msg.tsx";
import { Tab, TabNav } from "./TabNav.tsx";

export type SettingsNavItem = "profile" | "language";

export interface SettingsNavProps {
  active: SettingsNavItem;
  settingsHref: string;
}

export function SettingsNav({ active, settingsHref }: SettingsNavProps) {
  return (
    <TabNav class="mt-2">
      <Tab selected={active === "profile"} href={settingsHref}>
        <Msg $key="settings.profile.title" />
      </Tab>
      <Tab selected={active === "language"} href={`${settingsHref}/language`}>
        <Msg $key="settings.language.title" />
      </Tab>
    </TabNav>
  );
}
