import { Meta } from "@solidjs/meta";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorSharedPostList } from "~/components/ActorSharedPostList.tsx";
import { ProfilePageBreadcrumbItem } from "~/components/ProfilePageBreadcrumb.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { sharesPageQuery } from "./__generated__/sharesPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const { i18n } = useLingui();
    void loadPageQuery(args.params.handle, i18n.locale);
  },
} satisfies RouteDefinition;

const sharesPageQuery = graphql`
  query sharesPageQuery($handle: String!, $locale: Locale!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      rawName
      username
      ...ActorSharedPostList_sharedPosts @arguments(locale: $locale)
      ...ProfileTabs_actor
    }
  }
`;

const loadPageQuery = query(
  (handle: string, locale: string) =>
    loadQuery<sharesPageQuery>(
      useRelayEnvironment()(),
      sharesPageQuery,
      { handle, locale },
    ),
  "loadSharesPageQuery",
);

export default function ProfileSharesPage() {
  const params = useParams();
  const { t, i18n } = useLingui();
  const data = createPreloadedQuery<sharesPageQuery>(
    sharesPageQuery,
    () => loadPageQuery(params.handle, i18n.locale),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show when={data().actorByHandle}>
            {(actor) => (
              <>
                <Title>
                  {t`${actor().rawName ?? actor().username}'s shares`}
                </Title>
                <Meta
                  property="og:title"
                  content={t`${actor().rawName ?? actor().username}'s shares`}
                />
                <ProfilePageBreadcrumbItem breadcrumb={t`Shares`} />
                <ProfileTabs selected="shares" $actor={actor()} />
                <ActorSharedPostList $sharedPosts={actor()} />
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
