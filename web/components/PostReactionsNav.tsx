import { Msg, type MsgKey } from "./Msg.tsx";
import { Tab, TabNav } from "./TabNav.tsx";

export type PostReactionsNavItem = "reactions" | "sharers";

export interface PostReactionsNavProps {
  active: PostReactionsNavItem;
  hrefs: Record<PostReactionsNavItem, string>;
  stats: Record<PostReactionsNavItem, number>;
}

const labels: [PostReactionsNavItem, MsgKey][] = [
  ["reactions", "post.reactions.title"],
  ["sharers", "post.reactions.sharers"],
];

export function PostReactionsNav(
  { active, hrefs, stats }: PostReactionsNavProps,
) {
  return (
    <TabNav>
      {labels.map(([key, label]) => (
        <Tab selected={active === key} href={hrefs[key]}>
          <Msg $key={label} />
          <span class="opacity-50 ml-1 font-normal">({stats[key]})</span>
        </Tab>
      ))}
    </TabNav>
  );
}
