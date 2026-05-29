import { Link, Meta } from "@solidjs/meta";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorPostList } from "~/components/ActorPostList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NavigateIfHandleIsNotCanonical } from "~/components/NavigateIfHandleIsNotCanonical.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { PostCard } from "~/components/PostCard.tsx";
import { PostListSkeleton } from "~/components/PostListSkeleton.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  PROFILE_PAGE_BASE_QUERY_KEY,
  PROFILE_PAGE_PINS_QUERY_KEY,
  PROFILE_PAGE_POSTS_QUERY_KEY,
  profileContentRevalidating,
} from "~/lib/profileContentQueries.ts";
import IconPin from "~icons/lucide/pin";
import type { ProfilePageBaseQuery } from "./__generated__/ProfilePageBaseQuery.graphql.ts";
import type { ProfilePageContentQuery } from "./__generated__/ProfilePageContentQuery.graphql.ts";
import type { ProfilePagePinsQuery } from "./__generated__/ProfilePagePinsQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

// Actor metadata and post content are split into two queries to keep each
// below the GraphQL complexity limit (20 000 unauthenticated / 25 000 authed).
// The former single ProfilePageQuery exceeded the limit at 24 572.
//
// Profile metadata (ProfileCard, ProfileTabs, nav redirect) is locale-independent
// and cheap, so it fetches under ProfilePageBaseQuery with no $locale argument.
// The paginated post list is locale-keyed and goes in ProfilePageContentQuery.
//
// Pins are loaded via a *separate* ProfilePagePinsQuery that fires client-side
// only (via createEffect, which is a no-op during SSR).  This prevents the
// pins + posts combined complexity from exceeding 20 000 for unauthenticated
// users: each of the two content queries is ~12 000 individually.
//
// We use two createPreloadedQuery calls rather than three because the original
// three-locale-keyed-query design caused a cascading reactive update / call-stack
// overflow during sidebar navigation (commit 22ea918e, XiNiHa/solid-relay#66).
// With only one locale-keyed query the dependency graph is asymmetric and the
// cascade does not occur.
//
// The remaining multi-second freeze on first navigation into this route is tracked
// upstream at https://github.com/XiNiHa/solid-relay/issues/66.
const ProfilePageBaseQuery = graphql`
  query ProfilePageBaseQuery($handle: String!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      id
      rawName
      username
      url
      iri
      local
      viewerBlocks
      blocksViewer
      ...NavigateIfHandleIsNotCanonical_actor
      ...ProfileCard_actor
      ...ProfileTabs_actor
    }
  }
`;

const ProfilePageContentQuery = graphql`
  query ProfilePageContentQuery($handle: String!, $locale: Locale) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      id
      isViewer
      viewerBlocks
      blocksViewer
      posts(first: 20) @connection(key: "ActorPostList_posts") {
        __id
        edges {
          cursor
        }
      }
      ...ActorPostList_posts @arguments(locale: $locale)
    }
  }
`;

// Loaded client-side only (via createEffect) so that SSR never sends a query
// that would hit the complexity limit for unauthenticated users.  Complexity of
// pins(5) × PostCard is ~12 200, which is under 20 000 on its own.
const ProfilePagePinsQuery = graphql`
  query ProfilePagePinsQuery($handle: String!, $locale: Locale) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      id
      isViewer
      pins(first: 20) @connection(key: "ProfilePage_pins") {
        __id
        edges {
          node {
            ...PostCard_post @arguments(locale: $locale)
            id
          }
          cursor
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
`;

const loadBaseQuery = routePreloadedQuery(
  (handle: string) =>
    loadQuery<ProfilePageBaseQuery>(
      useRelayEnvironment()(),
      ProfilePageBaseQuery,
      { handle },
      { fetchPolicy: "store-and-network" },
    ),
  PROFILE_PAGE_BASE_QUERY_KEY,
);

const loadContentQuery = routePreloadedQuery(
  (handle: string, locale: string) =>
    loadQuery<ProfilePageContentQuery>(
      useRelayEnvironment()(),
      ProfilePageContentQuery,
      { handle, locale },
      { fetchPolicy: "store-and-network" },
    ),
  PROFILE_PAGE_POSTS_QUERY_KEY,
);

const loadPinsQuery = routePreloadedQuery(
  (handle: string, locale: string) =>
    loadQuery<ProfilePagePinsQuery>(
      useRelayEnvironment()(),
      ProfilePagePinsQuery,
      { handle, locale },
      { fetchPolicy: "store-and-network" },
    ),
  PROFILE_PAGE_PINS_QUERY_KEY,
);

export default function ProfilePage() {
  const { i18n, t } = useLingui();
  const params = useParams();
  const baseData = createStablePreloadedQuery<ProfilePageBaseQuery>(
    ProfilePageBaseQuery,
    () => loadBaseQuery(params.handle!),
  );
  const contentData = createStablePreloadedQuery<ProfilePageContentQuery>(
    ProfilePageContentQuery,
    () => loadContentQuery(params.handle!, i18n.locale),
  );

  // Pins are loaded client-side only, and must not render during the hydration
  // pass. If loadPinsQuery returns data synchronously (Relay store cache hit),
  // pinsData() would be truthy during the client's initial render while SSR
  // produced no pins HTML — causing a hydration mismatch.
  //
  // The hydrated guard ensures the createEffect body does not run until after
  // onMount fires (which is guaranteed post-hydration). createEffect then
  // tracks params.handle and i18n.locale reactively so pins reload on
  // subsequent navigations to other profiles.
  const [hydrated, setHydrated] = createSignal(false);
  onMount(() => setHydrated(true));
  const [pinsQueryRef, setPinsQueryRef] = createSignal<
    ReturnType<typeof loadPinsQuery> | null
  >(null);
  createEffect(() => {
    if (!hydrated()) return;
    setPinsQueryRef(loadPinsQuery(params.handle!, i18n.locale));
  });
  const pinsData = createPreloadedQuery<ProfilePagePinsQuery>(
    ProfilePagePinsQuery,
    // pinsQueryRef() is null until the client effect fires; solid-relay's
    // createPreloadedQuery/createResource treats a null source as inactive.
    () => pinsQueryRef()!,
  );

  return (
    <Show keyed when={baseData()}>
      {(base) => (
        <>
          {
            /*
            `keyed` prevents a "Stale read from <Show>" race: when
            solid-relay's fragment subscription publishes a new snapshot
            inside `batch()`, a non-keyed `<Show>{(actor) => ...}` accessor
            can throw if `actorByHandle` flips to falsy in the same tick
            that an inner reactive computation re-runs. Reconcile keeps the
            actor's identity stable (`key: "__id"`), so `keyed` only
            re-mounts when navigating to a different actor.
          */
          }
          <Show
            keyed
            when={base.actorByHandle}
            fallback={<NotFoundPage fullscreen />}
          >
            {(actor) => (
              <NarrowContainer>
                <Link rel="canonical" href={actor.url ?? actor.iri} />
                <Link
                  rel="alternate"
                  type="application/activity+json"
                  href={actor.iri}
                />
                <Title>{actor.rawName ?? actor.username}</Title>
                <Meta property="og:type" content="profile" />
                <Meta property="og:url" content={actor.url ?? actor.iri} />
                <Meta
                  property="og:title"
                  content={actor.rawName ?? actor.username}
                />
                <Show keyed when={profileOgImageUrl(actor)}>
                  {(ogImageUrl) => (
                    <>
                      <Meta property="og:image" content={ogImageUrl} />
                      <Meta property="og:image:width" content="1200" />
                      <Meta property="og:image:height" content="630" />
                      <Meta
                        name="twitter:card"
                        content="summary_large_image"
                      />
                    </>
                  )}
                </Show>
                <Meta property="profile:username" content={actor.username} />
                <NavigateIfHandleIsNotCanonical $actor={actor} />
                <div>
                  <ProfileCard $actor={actor} />
                </div>
                <Show
                  keyed
                  when={contentData()}
                  fallback={<PostListSkeleton />}
                >
                  {(content) => (
                    <Show
                      keyed
                      when={content.actorByHandle?.id === actor.id
                        ? content.actorByHandle
                        : undefined}
                      fallback={<PostListSkeleton />}
                    >
                      {(contentActor) => {
                        const postConnections = () =>
                          contentActor.posts?.__id
                            ? [contentActor.posts.__id]
                            : [];
                        const viewerPostConnections = () =>
                          contentActor.isViewer ? postConnections() : [];
                        // Pin connections come from the client-only pinsData.
                        // Guard by actor.id to prevent showing stale pins from the
                        // previous profile during navigation while base has updated
                        // but the pins query response is still in flight.
                        const pinsActor = () => {
                          const pa = pinsData()?.actorByHandle;
                          return pa?.id === contentActor.id ? pa : null;
                        };
                        const pinConnections = () => {
                          const a = pinsActor();
                          return a?.pins.__id ? [a.pins.__id] : [];
                        };
                        const viewerPinConnections = () =>
                          (contentActor.isViewer || pinsActor()?.isViewer)
                            ? pinConnections()
                            : [];
                        return (
                          <Show
                            when={!contentActor.viewerBlocks &&
                              !contentActor.blocksViewer &&
                              !profileContentRevalidating()}
                          >
                            <div class="p-4">
                              <ProfileTabs selected="posts" $actor={actor} />
                              <Show
                                keyed
                                when={pinsActor()}
                              >
                                {(pa) => (
                                  <Show
                                    when={(pa.pins?.edges?.length ?? 0) > 0}
                                  >
                                    <section class="my-4">
                                      <h2 class="mb-2 flex items-center gap-2 px-1 text-sm font-medium text-muted-foreground">
                                        <IconPin class="size-4" />
                                        {t`Pinned posts`}
                                      </h2>
                                      <div class="overflow-hidden rounded-lg border bg-card shadow-sm">
                                        <For
                                          each={pa.pins?.edges ?? []}
                                        >
                                          {(edge) => (
                                            <PostCard
                                              $post={edge.node}
                                              connections={viewerPostConnections()}
                                              pinConnections={viewerPinConnections()}
                                            />
                                          )}
                                        </For>
                                      </div>
                                    </section>
                                  </Show>
                                )}
                              </Show>
                              <ActorPostList
                                $posts={contentActor}
                                pinConnections={viewerPinConnections()}
                              />
                            </div>
                          </Show>
                        );
                      }}
                    </Show>
                  )}
                </Show>
              </NarrowContainer>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

function profileOgImageUrl(actor: {
  readonly local: boolean;
  readonly url: string | null | undefined;
}) {
  if (!actor.local || actor.url == null) return undefined;
  const url = new URL(actor.url);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/og`;
  return url.toString();
}
