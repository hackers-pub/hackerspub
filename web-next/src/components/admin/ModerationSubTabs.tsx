import { A } from "@solidjs/router";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export type ModerationSubTab =
  | "cases"
  | "appeals"
  | "statistics"
  | "sanctioned";

export interface ModerationSubTabsProps {
  selected: ModerationSubTab;
}

/** Sub-navigation within the moderator-only moderation area. */
export function ModerationSubTabs(props: ModerationSubTabsProps) {
  const { t } = useLingui();
  return (
    <Tabs value={props.selected} class="mt-4">
      <div class="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList class="min-w-full justify-start">
          <TabsTrigger
            as={A}
            value="cases"
            href="/admin/moderation"
            class="shrink-0"
          >
            {t`Cases`}
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="appeals"
            href="/admin/moderation/appeals"
            class="shrink-0"
          >
            {t`Appeals`}
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="sanctioned"
            href="/admin/moderation/sanctioned"
            class="shrink-0"
          >
            {t`Sanctioned`}
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="statistics"
            href="/admin/moderation/statistics"
            class="shrink-0"
          >
            {t`Statistics`}
          </TabsTrigger>
        </TabsList>
      </div>
    </Tabs>
  );
}
