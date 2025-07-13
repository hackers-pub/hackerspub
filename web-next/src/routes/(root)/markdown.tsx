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
import type { markdownPageQuery } from "./__generated__/markdownPageQuery.graphql.ts";

export const route = {
  preload() {
    const { i18n } = useLingui();
    void loadPageQuery(i18n.locale);
  },
} satisfies RouteDefinition;

const markdownPageQuery = graphql`
  query markdownPageQuery($locale: Locale!) {
    markdownGuide(locale: $locale) {
      ...DocumentView_document
    }
  }
`;

const loadPageQuery = query(
  (locale: Intl.Locale | string) =>
    loadQuery<markdownPageQuery>(
      useRelayEnvironment()(),
      markdownPageQuery,
      { locale: typeof locale === "string" ? locale : locale.baseName },
    ),
  "loadMarkdownPageQuery",
);

export default function MarkdownPage() {
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<markdownPageQuery>(
    markdownPageQuery,
    () => loadPageQuery(i18n.locale),
  );
  return (
    <>
      <Title>{t`Markdown guide`} &mdash; {t`Hackers' Pub`}</Title>
      <TopBreadcrumb>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink current>
            {t`Markdown guide`}
          </BreadcrumbLink>
        </BreadcrumbItem>
      </TopBreadcrumb>
      <Show when={data()}>
        {(data) => <DocumentView $document={data().markdownGuide} />}
      </Show>
    </>
  );
}
