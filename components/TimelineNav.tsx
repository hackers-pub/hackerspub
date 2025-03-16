import { Msg } from "./Msg.tsx";
import { Tab, TabNav } from "./TabNav.tsx";

export type TimelineNavItem =
  | "fediverse"
  | "local"
  | "withoutShares"
  | "mentions"
  | "recommendations";

export interface TimelineNavProps {
  active: TimelineNavItem;
  signedIn: boolean;
}

export function TimelineNav({ active, signedIn }: TimelineNavProps) {
  return (
    <TabNav>
      <Tab selected={active === "fediverse"} href="/">
        <Msg $key="timeline.fediverse" />
      </Tab>
      <Tab selected={active === "local"} href="/?filter=local">
        <Msg $key="timeline.local" />
      </Tab>
      <Tab selected={active === "withoutShares"} href="/?filter=withoutShares">
        <Msg $key="timeline.withoutShares" />
      </Tab>
      {signedIn && (
        <>
          <Tab selected={active === "mentions"} href="/?filter=mentions">
            <Msg $key="timeline.mentions" />
          </Tab>
          <Tab
            selected={active === "recommendations"}
            href="/?filter=recommendations"
          >
            <Msg $key="timeline.recommendations" />
          </Tab>
        </>
      )}
    </TabNav>
  );
}
