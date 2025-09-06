import { query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { PublicTimeline } from "~/components/PublicTimeline.tsx";
import { TopBreadcrumb } from "~/components/TopBreadcrumb.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb.tsx";
import type { RootRoutesQuery } from "./__generated__/RootRoutesQuery.graphql.ts";

export const route = {
  preload() {
    const { i18n } = useLingui();
    void loadRoutesQuery(i18n.locale);
  },
} satisfies RouteDefinition;

const RootRoutesQuery = graphql`
  query RootRoutesQuery($locale: Locale) {
    ...PublicTimeline_posts @arguments(locale: $locale)
  }
`;

const loadRoutesQuery = query(
  (locale: string) =>
    loadQuery<RootRoutesQuery>(useRelayEnvironment()(), RootRoutesQuery, {
      locale,
    }),
  "loadRoutesQuery",
);

export default function Home() {
  const { i18n, t } = useLingui();
  const data = createPreloadedQuery<RootRoutesQuery>(
    RootRoutesQuery,
    () => loadRoutesQuery(i18n.locale),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <TopBreadcrumb>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink current>{t`Feed`}</BreadcrumbLink>
            </BreadcrumbItem>
          </TopBreadcrumb>
          <div class="p-4">
            <PublicTimeline $posts={data()} />
          </div>
        </>
      )}
    </Show>
  );
}
