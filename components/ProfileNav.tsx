import { Translation } from "./Msg.tsx";

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
}

export function ProfileNav({ active, stats, profileHref }: ProfileNavProps) {
  function Item(
    { href, label, item }: {
      href: string;
      label: string;
      item: ProfileNavItem;
    },
  ) {
    return item === active
      ? (
        <a
          href={href}
          class="block p-4 bg-stone-200 text-stone-900 dark:bg-stone-800 dark:text-stone-100 font-bold"
        >
          {label}
        </a>
      )
      : (
        <a
          href={href}
          class="block p-4 text-stone-500 hover:bg-stone-200 dark:text-stone-500 dark:hover:bg-stone-800"
        >
          {label}
        </a>
      );
  }

  return (
    <Translation>
      {(t, lang) => (
        <nav class="mt-6 border-b border-stone-300 dark:border-stone-700 flex">
          <Item
            href={profileHref}
            label={t("profile.total", {
              total: stats.total.toLocaleString(lang),
            })}
            item="total"
          />
          <Item
            href={`${profileHref}/notes`}
            label={t("profile.notes", {
              notes: stats.notes.toLocaleString(lang),
            })}
            item="notes"
          />
          <Item
            href={`${profileHref}/notes?replies`}
            label={t("profile.notesWithReplies", {
              notesWithReplies: stats.notesWithReplies.toLocaleString(lang),
            })}
            item="notesWithReplies"
          />
          <Item
            href={`${profileHref}/shares`}
            label={t("profile.shares", {
              shares: stats.shares.toLocaleString(lang),
            })}
            item="shares"
          />
          <Item
            href={`${profileHref}/articles`}
            label={t("profile.articles", {
              articles: stats.articles.toLocaleString(lang),
            })}
            item="articles"
          />
        </nav>
      )}
    </Translation>
  );
}
