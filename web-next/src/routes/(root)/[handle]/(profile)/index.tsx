import { Link, Meta } from "@solidjs/meta";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorPostList } from "~/components/ActorPostList.tsx";
import { ProfilePageBreadcrumbItem } from "~/components/ProfilePageBreadcrumb.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ProfilePageQuery } from "./__generated__/ProfilePageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const { i18n } = useLingui();
    void loadPageQuery(args.params.handle, i18n.locale);
  },
} satisfies RouteDefinition;

const ProfilePageQuery = graphql`
  query ProfilePageQuery($handle: String!, $locale: Locale) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      rawName
      username
      url
      iri
      ...ActorPostList_posts @arguments(locale: $locale)
      ...ProfileTabs_actor
    }
  }
`;

const loadPageQuery = query(
  (handle: string, locale: string) =>
    loadQuery<ProfilePageQuery>(
      useRelayEnvironment()(),
      ProfilePageQuery,
      { handle, locale },
    ),
  "loadProfilePageQuery",
);

export default function ProfilePage() {
  const { i18n } = useLingui();
  const params = useParams();
  const data = createPreloadedQuery<ProfilePageQuery>(
    ProfilePageQuery,
    () => loadPageQuery(params.handle, i18n.locale),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show when={data().actorByHandle}>
            {(actor) => (
              <>
                <Link rel="canonical" href={actor().url ?? actor().iri} />
                <Link
                  rel="alternate"
                  type="application/activity+json"
                  href={actor().iri}
                />
                <Meta property="og:type" content="profile" />
                <Meta property="og:url" content={actor().url ?? actor().iri} />
                <Meta
                  property="og:title"
                  content={actor().rawName ?? actor().username}
                />
                <Meta property="profile:username" content={actor().username} />
                <Title>{actor().rawName ?? actor().username}</Title>
                <ProfilePageBreadcrumbItem breadcrumb={undefined} />
                <ProfileTabs selected="posts" $actor={actor()} />
                <ActorPostList $posts={actor()} />
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
