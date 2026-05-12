import { A } from "@solidjs/router";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";

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
 * routes (`/shares`, `/quotes`, `/reactions`).  Tabs are rendered as
 * real `<A>` links so each route owns its own data fetch and the
 * browser history reflects the active view.
 */
export function EngagementTabs(props: EngagementTabsProps) {
  const { i18n } = useLingui();
  const labels = () => ({
    shares: i18n._(
      msg`${plural(props.shares, { one: "# share", other: "# shares" })}`,
    ),
    quotes: i18n._(
      msg`${plural(props.quotes, { one: "# quote", other: "# quotes" })}`,
    ),
    reactions: i18n._(
      msg`${
        plural(props.reactions, { one: "# reaction", other: "# reactions" })
      }`,
    ),
  });

  const tabClass = (tab: EngagementTab) =>
    `flex-1 px-4 py-3 text-center text-sm font-medium border-b-2 transition-colors ${
      props.active === tab
        ? "border-foreground text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"
    }`;

  return (
    <nav
      class="flex border-b"
      role="tablist"
      aria-label="Engagement tabs"
    >
      <A
        href={`${props.base}/shares`}
        class={tabClass("shares")}
        role="tab"
        aria-selected={props.active === "shares"}
      >
        {labels().shares}
      </A>
      <A
        href={`${props.base}/quotes`}
        class={tabClass("quotes")}
        role="tab"
        aria-selected={props.active === "quotes"}
      >
        {labels().quotes}
      </A>
      <A
        href={`${props.base}/reactions`}
        class={tabClass("reactions")}
        role="tab"
        aria-selected={props.active === "reactions"}
      >
        {labels().reactions}
      </A>
    </nav>
  );
}
