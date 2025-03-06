export type AdminNavItem = "accounts" | "allowlist";

export interface AdminNavProps {
  active: AdminNavItem;
}

export function AdminNav(props: AdminNavProps) {
  function Item(
    { href, label, item }: { href: string; label: string; item: AdminNavItem },
  ) {
    return (
      <a
        href={href}
        class={`${
          item === props.active
            ? "font-bold text-stone-800 dark:text-stone-200"
            : "text-gray-600 dark:text-stone-400"
        }`}
      >
        {label}
      </a>
    );
  }

  return (
    <nav class="mb-5">
      <Item href="/admin" label="Accounts" item="accounts" /> &middot;{" "}
      <Item href="/admin/allowlist" label="Allowed emails" item="allowlist" />
    </nav>
  );
}
