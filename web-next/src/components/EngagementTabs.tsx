import { A } from "@solidjs/router";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export type EngagementTab = "shares" | "quotes" | "reactions";

export interface EngagementTabsProps {
  /** Permalink base, e.g. `/@dahlia/{noteId}` — without the segment. */
  base: string;
  active: EngagementTab;
  shares: number;
  quotes: number;
  reactions: number;
}

/**
 * Top-of-page tab navigation shared by the three engagement-detail
 * routes (`/shares`, `/quotes`, `/reactions`).  Reuses the solid-ui
 * `Tabs`/`TabsList`/`TabsTrigger` primitives so the visual matches the
 * rest of the app (e.g. SettingsTabs, ProfileTabs).  Each trigger is
 * an `<A>` link so the browser history reflects the active view and
 * modifier-clicks (cmd/ctrl-click, middle-click) keep their native
 * new-tab behaviour.
 */
export function EngagementTabs(props: EngagementTabsProps) {
  const { t } = useLingui();
  return (
    <Tabs value={props.active}>
      <div class="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <TabsList class="min-w-full justify-start">
          <TabsTrigger
            as={A}
            value="shares"
            href={`${props.base}/shares`}
            class="shrink-0"
          >
            {t`Shares`}
            <TabCount count={props.shares} />
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="quotes"
            href={`${props.base}/quotes`}
            class="shrink-0"
          >
            {t`Quotes`}
            <TabCount count={props.quotes} />
          </TabsTrigger>
          <TabsTrigger
            as={A}
            value="reactions"
            href={`${props.base}/reactions`}
            class="shrink-0"
          >
            {t`Reactions`}
            <TabCount count={props.reactions} />
          </TabsTrigger>
        </TabsList>
      </div>
    </Tabs>
  );
}

// Engagement counts sit beside each tab label in parentheses, dimmed
// to ~60% of the trigger's current text colour so the label
// dominates regardless of whether the tab is selected (foreground
// text) or unselected (muted text).  `tabular-nums` so the digits
// don't bounce when counts grow or shrink across pagination.
function TabCount(props: { count: number }) {
  return (
    <span class="ml-1 opacity-60 tabular-nums">
      ({props.count})
    </span>
  );
}
