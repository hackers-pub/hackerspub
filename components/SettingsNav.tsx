import { Msg } from "./Msg.tsx";
import { Tab, TabNav } from "./TabNav.tsx";

export type SettingsNavItem = "profile" | "language" | "invite";

export interface SettingsNavProps {
  active: SettingsNavItem;
  settingsHref: string;
  leftInvitations: number;
}

export function SettingsNav(
  { active, settingsHref, leftInvitations }: SettingsNavProps,
) {
  return (
    <TabNav class="mt-2">
      <Tab selected={active === "profile"} href={settingsHref}>
        <Msg $key="settings.profile.title" />
      </Tab>
      <Tab selected={active === "language"} href={`${settingsHref}/language`}>
        <Msg $key="settings.language.title" />
      </Tab>
      <Tab selected={active === "invite"} href={`${settingsHref}/invite`}>
        <Msg $key="settings.invite.title" />
        <span class="opacity-50 ml-1 font-normal">({leftInvitations})</span>
      </Tab>
    </TabNav>
  );
}
