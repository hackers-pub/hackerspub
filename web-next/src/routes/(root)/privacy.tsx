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
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { privacyPolicyPageQuery } from "./__generated__/privacyPolicyPageQuery.graphql.ts";

export const route = {
  preload() {
    const { i18n } = useLingui();
    void loadPageQuery(i18n.locale);
  },
} satisfies RouteDefinition;

const privacyPolicyPageQuery = graphql`
  query privacyPolicyPageQuery($locale: Locale!) {
    privacyPolicy(locale: $locale) {
      ...DocumentView_document
    }
  }
`;

const loadPageQuery = query(
  (locale: Intl.Locale | string) =>
    loadQuery<privacyPolicyPageQuery>(
      useRelayEnvironment()(),
      privacyPolicyPageQuery,
      { locale: typeof locale === "string" ? locale : locale.baseName },
    ),
  "loadPrivacyPolicyPageQuery",
);

export default function PrivacyPage() {
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<privacyPolicyPageQuery>(
    privacyPolicyPageQuery,
    () => loadPageQuery(i18n.locale),
  );
  return (
    <WideContainer>
      <Title>{t`Privacy policy`} &mdash; {t`Hackers' Pub`}</Title>
      <Show keyed when={data()}>
        {(data) => <DocumentView $document={data.privacyPolicy} />}
      </Show>
    </WideContainer>
  );
}
