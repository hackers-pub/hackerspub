import type { Locale } from "@hackerspub/models/i18n";
import { query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { TopBreadcrumb } from "~/components/TopBreadcrumb.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { cocPageQuery } from "./__generated__/cocPageQuery.graphql.ts";

export const route = {
  preload() {
    const { i18n } = useLingui();
    void loadPageQuery(i18n.locale as Locale);
  },
} satisfies RouteDefinition;

const cocPageQuery = graphql`
  query cocPageQuery($locale: Locale!) {
    codeOfConduct(locale: $locale) {
      toc
      html
    }
  }
`;

const loadPageQuery = query(
  (locale: Locale) =>
    loadQuery<cocPageQuery>(
      useRelayEnvironment()(),
      cocPageQuery,
      { locale },
    ),
  "loadCocPageQuery",
);

export default function CocPage() {
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<cocPageQuery>(
    cocPageQuery,
    () => loadPageQuery(i18n.locale as Locale),
  );
  return (
    <>
      <TopBreadcrumb>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink current>
            {t`Code of conduct`}
          </BreadcrumbLink>
        </BreadcrumbItem>
      </TopBreadcrumb>
      <Show when={data()}>
        {(data) => (
          <div
            class="p-4 prose dark:prose-invert ml-auto mr-auto"
            innerHTML={data().codeOfConduct.html}
          />
        )}
      </Show>
    </>
  );
}
