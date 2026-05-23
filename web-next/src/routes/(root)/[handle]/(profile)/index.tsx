import { Link, Meta } from "@solidjs/meta";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorPostList } from "~/components/ActorPostList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NavigateIfHandleIsNotCanonical } from "~/components/NavigateIfHandleIsNotCanonical.tsx";
import { PostCard } from "~/components/PostCard.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  PROFILE_PAGE_POSTS_QUERY_KEY,
  profileContentRevalidating,
} from "~/lib/profileContentQueries.ts";
import IconPin from "~icons/lucide/pin";
import type { ProfilePageQuery } from "./__generated__/ProfilePageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

const ProfilePageQuery = graphql`
  query ProfilePageQuery($handle: String!, $locale: Locale) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      isViewer
      rawName
      username
      url
      iri
      local
      viewerBlocks
      blocksViewer
      pins(first: 20) @connection(key: "ProfilePage_pins") {
        __id
        edges {
          node {
            ...PostCard_post @arguments(locale: $locale)
          }
        }
      }
      posts(first: 20) @connection(key: "ActorPostList_posts") {
        __id
        edges {
          __id
        }
      }
      ...NavigateIfHandleIsNotCanonical_actor
      ...ActorPostList_posts @arguments(locale: $locale)
      ...ProfileCard_actor
      ...ProfileTabs_actor
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (handle: string, locale: string) =>
    loadQuery<ProfilePageQuery>(
      useRelayEnvironment()(),
      ProfilePageQuery,
      { handle, locale },
      { fetchPolicy: "store-and-network" },
    ),
  PROFILE_PAGE_POSTS_QUERY_KEY,
);

export default function ProfilePage() {
  const { i18n, t } = useLingui();
  const params = useParams();
  const data = createPreloadedQuery<ProfilePageQuery>(
    ProfilePageQuery,
    () => loadPageQuery(params.handle!, i18n.locale),
  );
  return (
    <Show keyed when={data()}>
      {(data) => (
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
          <Show keyed when={data.actorByHandle}>
            {(actor) => {
              const pinConnections = () => [actor.pins.__id];
              const postConnections = () => [actor.posts.__id];
              const viewerPinConnections = () =>
                actor.isViewer ? pinConnections() : [];
              const viewerPostConnections = () =>
                actor.isViewer ? postConnections() : [];
              return (
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
                    when={!actor.viewerBlocks && !actor.blocksViewer &&
                      !profileContentRevalidating()}
                  >
                    <div class="p-4">
                      <ProfileTabs selected="posts" $actor={actor} />
                      <Show when={actor.pins.edges.length > 0}>
                        <section class="my-4">
                          <h2 class="mb-2 flex items-center gap-2 px-1 text-sm font-medium text-muted-foreground">
                            <IconPin class="size-4" />
                            {t`Pinned posts`}
                          </h2>
                          <div class="overflow-hidden rounded-lg border bg-card shadow-sm">
                            <For each={actor.pins.edges}>
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
                      <ActorPostList
                        $posts={actor}
                        pinConnections={viewerPinConnections()}
                      />
                    </div>
                  </Show>
                </NarrowContainer>
              );
            }}
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
