import { A } from "@solidjs/router";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export type AdminTab =
  | "accounts"
  | "invitations"
  | "media"
  | "news"
  | "refresh"
  | "relays";

export interface AdminTabsProps {
  selected: AdminTab;
}

export function AdminTabs(props: AdminTabsProps) {
  const { t } = useLingui();

  return (
    <Tabs value={props.selected}>
      <div class="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList class="min-w-full justify-start">
          <TabsTrigger as={A} value="accounts" href="/admin" class="shrink-0">
            {t`Accounts`}
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="invitations"
            href="/admin/invitations"
            class="shrink-0"
          >
            {t`Invitations`}
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="media"
            href="/admin/media"
            class="shrink-0"
          >
            {t`Media`}
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="news"
            href="/admin/news"
            class="shrink-0"
          >
            {t`News`}
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="refresh"
            href="/admin/refresh"
            class="shrink-0"
          >
            {t`Refresh`}
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="relays"
            href="/admin/relay"
            class="shrink-0"
          >
            {t`Relays`}
          </TabsTrigger>
        </TabsList>
      </div>
    </Tabs>
  );
}
