import { Title } from "@solidjs/meta";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { DocumentView } from "~/components/DocumentView.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { markdownPageQuery } from "./__generated__/markdownPageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

const markdownPageQuery = graphql`
  query markdownPageQuery($locale: Locale!) {
    markdownGuide(locale: $locale) {
      ...DocumentView_document
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
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
    <WideContainer>
      <Title>{t`Markdown guide`} &mdash; {t`Hackers' Pub`}</Title>
      <Show keyed when={data()}>
        {(data) => <DocumentView $document={data.markdownGuide} />}
      </Show>
    </WideContainer>
  );
}
