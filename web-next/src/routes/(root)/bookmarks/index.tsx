import {
  Navigate,
  query,
  type RouteDefinition,
  useSearchParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { type BookmarkPostType, Bookmarks } from "~/components/Bookmarks.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { bookmarksQuery } from "./__generated__/bookmarksQuery.graphql.ts";

export const route = {
  preload() {
    const { i18n } = useLingui();
    void loadBookmarksQuery(i18n.locale);
  },
} satisfies RouteDefinition;

const bookmarksQuery = graphql`
  query bookmarksQuery($locale: Locale) {
    ...Bookmarks_posts @arguments(locale: $locale)
  }
`;

const loadBookmarksQuery = query(
  (locale: string) =>
    loadQuery<bookmarksQuery>(
      useRelayEnvironment()(),
      bookmarksQuery,
      { locale },
    ),
  "loadBookmarksQuery",
);

function mapTypeParam(value: string | undefined): BookmarkPostType {
  if (value === "articles") return "ARTICLE";
  if (value === "notes") return "NOTE";
  return null;
}

export default function BookmarksPage() {
  const { t, i18n } = useLingui();
  const viewer = useViewer();
  const [searchParams, setSearchParams] = useSearchParams<{ type?: string }>();
  const data = createPreloadedQuery<bookmarksQuery>(
    bookmarksQuery,
    () => loadBookmarksQuery(i18n.locale),
  );

  const activeType = () => searchParams.type ?? "all";
  const postType = () => mapTypeParam(searchParams.type);

  return (
    <Show when={viewer.isLoaded()}>
      <Show
        when={viewer.isAuthenticated()}
        fallback={<Navigate href="/sign?next=%2Fbookmarks" />}
      >
        <Show when={data()}>
          {(data) => (
            <NarrowContainer>
              <Tabs
                value={activeType()}
                onChange={(value) =>
                  setSearchParams({
                    type: value === "all" ? undefined : value,
                  })}
                class="px-4 py-3"
              >
                <TabsList>
                  <TabsTrigger value="all">{t`All`}</TabsTrigger>
                  <TabsTrigger value="articles">{t`Articles`}</TabsTrigger>
                  <TabsTrigger value="notes">{t`Notes`}</TabsTrigger>
                </TabsList>
              </Tabs>
              <Bookmarks $posts={data()} postType={postType()} />
            </NarrowContainer>
          )}
        </Show>
      </Show>
    </Show>
  );
}
