import { Tab, TabNav } from "./TabNav.tsx";

export type AdminNavItem = "accounts" | "invitations" | "media";

export interface AdminNavProps {
  active: AdminNavItem;
}

export function AdminNav({ active }: AdminNavProps) {
  return (
    <TabNav class="mt-2 my-4">
      <Tab selected={active === "accounts"} href="/admin">
        Accounts
      </Tab>
      <Tab selected={active === "invitations"} href="/admin/invitations">
        Invitations
      </Tab>
      <Tab selected={active === "media"} href="/admin/media">
        Media
      </Tab>
    </TabNav>
  );
}
