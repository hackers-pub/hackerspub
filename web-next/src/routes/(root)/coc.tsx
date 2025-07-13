import { Title } from "@solidjs/meta";
import { query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { DocumentView } from "~/components/DocumentView.tsx";
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
    void loadPageQuery(i18n.locale);
  },
} satisfies RouteDefinition;

const cocPageQuery = graphql`
  query cocPageQuery($locale: Locale!) {
    codeOfConduct(locale: $locale) {
      ...DocumentView_document
    }
  }
`;

const loadPageQuery = query(
  (locale: Intl.Locale | string) =>
    loadQuery<cocPageQuery>(
      useRelayEnvironment()(),
      cocPageQuery,
      { locale: typeof locale === "string" ? locale : locale.baseName },
    ),
  "loadCocPageQuery",
);

export default function CocPage() {
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<cocPageQuery>(
    cocPageQuery,
    () => loadPageQuery(i18n.locale),
  );
  return (
    <>
      <Title>{t`Code of conduct`} &mdash; {t`Hackers' Pub`}</Title>
      <TopBreadcrumb>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink current>
            {t`Code of conduct`}
          </BreadcrumbLink>
        </BreadcrumbItem>
      </TopBreadcrumb>
      <Show when={data()}>
        {(data) => <DocumentView $document={data().codeOfConduct} />}
      </Show>
    </>
  );
}
