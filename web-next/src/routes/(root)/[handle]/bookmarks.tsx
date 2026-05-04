import {
  A,
  Navigate,
  query,
  revalidate,
  type RouteDefinition,
  useParams,
  useSearchParams,
} from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { Show, Suspense } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { type BookmarkPostType, Bookmarks } from "~/components/Bookmarks.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { Title } from "~/components/Title.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle as UICardTitle,
} from "~/components/ui/card.tsx";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { bookmarksPageQuery } from "./__generated__/bookmarksPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@[^@]+$/,
  },
  preload({ intent }) {
    const { i18n } = useLingui();
    if (intent !== "preload") {
      void revalidate(loadBookmarksPageQuery.keyFor(i18n.locale));
    }
    void loadBookmarksPageQuery(i18n.locale);
  },
} satisfies RouteDefinition;

const bookmarksPageQuery = graphql`
  query bookmarksPageQuery($locale: Locale) {
    viewer {
      username
    }
    ...Bookmarks_posts @arguments(locale: $locale)
  }
`;

const loadBookmarksPageQuery = query(
  (locale: string) =>
    loadQuery<bookmarksPageQuery>(
      useRelayEnvironment()(),
      bookmarksPageQuery,
      { locale },
      { fetchPolicy: "network-only" },
    ),
  "loadBookmarksPageQuery",
);

function mapTypeParam(value: string | undefined): BookmarkPostType {
  if (value === "articles") return "ARTICLE";
  if (value === "notes") return "NOTE";
  return null;
}

export default function BookmarksPage() {
  const { t, i18n } = useLingui();
  const viewer = useViewer();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams<{ type?: string }>();
  const data = createPreloadedQuery<bookmarksPageQuery>(
    bookmarksPageQuery,
    () => loadBookmarksPageQuery(i18n.locale),
  );

  const handleUsername = () => params.handle!.substring(1);
  const activeType = () => searchParams.type ?? "all";
  const postType = () => mapTypeParam(searchParams.type);

  return (
    <Show when={viewer.isLoaded()}>
      <Show
        when={viewer.isAuthenticated()}
        fallback={
          <Navigate
            href={`/sign?next=${
              encodeURIComponent(`/@${handleUsername()}/bookmarks`)
            }`}
          />
        }
      >
        <Show when={data.latest}>
          {(data) => (
            <Show
              when={data().viewer?.username === handleUsername()}
              fallback={
                <WideContainer class="px-4 py-6 sm:px-6 lg:py-8">
                  <HttpStatusCode code={403} />
                  <Title>{t`Permission denied`}</Title>
                  <Card class="mx-auto max-w-xl">
                    <CardHeader>
                      <UICardTitle>{t`Permission denied`}</UICardTitle>
                      <CardDescription>
                        {t`You can only view your own bookmarks`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="flex flex-wrap gap-2">
                      <Button onClick={() => window.history.back()}>
                        {t`Go back`}
                      </Button>
                      <Show when={data().viewer?.username}>
                        {(username) => (
                          <A href={`/@${username()}/bookmarks`}>
                            <Button variant="outline">
                              {t`Go to my bookmarks`}
                            </Button>
                          </A>
                        )}
                      </Show>
                    </CardContent>
                  </Card>
                </WideContainer>
              }
            >
              <NarrowContainer>
                <Title>{t`Bookmarks`}</Title>
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
                <Suspense>
                  <Bookmarks $posts={data()} postType={postType()} />
                </Suspense>
              </NarrowContainer>
            </Show>
          )}
        </Show>
      </Show>
    </Show>
  );
}
