import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { SearchGuide_searchGuideQuery } from "./__generated__/SearchGuide_searchGuideQuery.graphql.ts";

const searchGuideQuery = graphql`
  query SearchGuide_searchGuideQuery($locale: Locale!) {
    searchGuide(locale: $locale) {
      title
      html
    }
  }
`;

export function SearchGuide() {
  const { i18n } = useLingui();
  const env = useRelayEnvironment();

  const data = createPreloadedQuery<SearchGuide_searchGuideQuery>(
    searchGuideQuery,
    () => loadQuery(env(), searchGuideQuery, { locale: i18n.locale }),
  );

  return (
    <Show when={data()}>
      {(searchGuide) => (
        <div class="bg-background border border-border rounded-lg shadow-lg p-4 max-w-4xl">
          <h3 class="text-lg font-semibold mb-3 text-foreground">
            {searchGuide().searchGuide.title}
          </h3>
          <div
            class="prose prose-sm max-w-none prose-headings:text-foreground prose-p:text-foreground prose-td:text-foreground prose-th:text-foreground prose-strong:text-foreground prose-code:text-foreground prose-pre:bg-muted prose-th:border-border prose-td:border-border"
            innerHTML={searchGuide().searchGuide.html}
          />
        </div>
      )}
    </Show>
  );
}
