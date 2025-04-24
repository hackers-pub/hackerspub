import { Msg, Translation } from "./Msg.tsx";
import { Tab, TabNav } from "./TabNav.tsx";

export type ProfileNavItem =
  | "total"
  | "notes"
  | "notesWithReplies"
  | "shares"
  | "articles";

export interface ProfileNavProps {
  active: ProfileNavItem;
  stats: Record<ProfileNavItem, number>;
  profileHref: string;
  class?: string;
}

export function ProfileNav(
  { active, stats, profileHref, class: cls }: ProfileNavProps,
) {
  return (
    <Translation>
      {(_, lang) => (
        <TabNav class={cls}>
          <Tab selected={active === "total"} href={profileHref}>
            <Msg
              $key="profile.total"
              total={stats.total.toLocaleString(lang)}
            />
          </Tab>
          <Tab selected={active === "notes"} href={`${profileHref}/notes`}>
            <Msg
              $key="profile.notes"
              notes={stats.notes.toLocaleString(lang)}
            />
          </Tab>
          <Tab
            selected={active === "notesWithReplies"}
            href={`${profileHref}/notes?replies`}
          >
            <Msg
              $key="profile.notesWithReplies"
              notesWithReplies={stats.notesWithReplies.toLocaleString(lang)}
            />
          </Tab>
          <Tab selected={active === "shares"} href={`${profileHref}/shares`}>
            <Msg
              $key="profile.shares"
              shares={stats.shares.toLocaleString(lang)}
            />
          </Tab>
          <Tab
            selected={active === "articles"}
            href={`${profileHref}/articles`}
          >
            <Msg
              $key="profile.articles"
              articles={stats.articles.toLocaleString(lang)}
            />
          </Tab>
        </TabNav>
      )}
    </Translation>
  );
}
