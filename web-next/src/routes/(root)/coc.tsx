import { Title } from "@solidjs/meta";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { DocumentView } from "~/components/DocumentView.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { cocPageQuery } from "./__generated__/cocPageQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

const cocPageQuery = graphql`
  query cocPageQuery($locale: Locale!) {
    codeOfConduct(locale: $locale) {
      ...DocumentView_document
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (locale: Intl.Locale | string) =>
    loadQuery<cocPageQuery>(useRelayEnvironment()(), cocPageQuery, {
      locale: typeof locale === "string" ? locale : locale.baseName,
    }),
  "loadCocPageQuery",
);

export default function CocPage() {
  const { t, i18n } = useLingui();
  const data = createStablePreloadedQuery<cocPageQuery>(cocPageQuery, () =>
    loadPageQuery(i18n.locale),
  );
  return (
    <WideContainer>
      <Title>
        {t`Code of conduct`} &mdash; {t`Hackers' Pub`}
      </Title>
      <Show keyed when={data()}>
        {(data) => <DocumentView $document={data.codeOfConduct} />}
      </Show>
    </WideContainer>
  );
}
