import { A } from "@solidjs/router";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export type PostReactionsNavItem = "reactions" | "shares";

export interface PostReactionsNavProps {
  active: PostReactionsNavItem;
  hrefs: Record<PostReactionsNavItem, string>;
  stats: Record<PostReactionsNavItem, number>;
}

export function PostReactionsNav(props: PostReactionsNavProps) {
  const { t } = useLingui();

  const labels: Record<PostReactionsNavItem, string> = {
    reactions: t`Reactions`,
    shares: t`Shares`,
  };

  return (
    <div class="flex border-b my-4">
      {(Object.keys(props.hrefs) as PostReactionsNavItem[]).map((key) => (
        <A
          href={props.hrefs[key]}
          class="px-4 py-3 text-sm font-medium border-b-2 transition-colors"
          activeClass="border-primary text-primary"
          inactiveClass="border-transparent text-muted-foreground hover:text-foreground hover:border-border"
          end
        >
          {labels[key]}
          <span class="ml-2 text-muted-foreground">({props.stats[key]})</span>
        </A>
      ))}
    </div>
  );
}
