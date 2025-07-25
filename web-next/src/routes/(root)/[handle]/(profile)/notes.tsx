import { Meta, Title } from "@solidjs/meta";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { ActorNoteList } from "~/components/ActorNoteList.tsx";
import { NavigateIfHandleIsNotCanonical } from "~/components/NavigateIfHandleIsNotCanonical.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfilePageBreadcrumb } from "~/components/ProfilePageBreadcrumb.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { notesPageQuery } from "./__generated__/notesPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    void loadPageQuery(args.params.handle);
  },
} satisfies RouteDefinition;

const notesPageQuery = graphql`
  query notesPageQuery($handle: String!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      rawName
      username
      ...NavigateIfHandleIsNotCanonical_actor
      ...ActorNoteList_notes
      ...ProfilePageBreadcrumb_actor
      ...ProfileCard_actor
      ...ProfileTabs_actor
    }
  }
`;

const loadPageQuery = query(
  (handle: string) =>
    loadQuery<notesPageQuery>(
      useRelayEnvironment()(),
      notesPageQuery,
      { handle },
    ),
  "loadNotesPageQuery",
);

export default function ProfileNotesPage() {
  const params = useParams();
  const { t } = useLingui();
  const data = createPreloadedQuery<notesPageQuery>(
    notesPageQuery,
    () => loadPageQuery(params.handle),
  );
  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show
            when={data().actorByHandle}
          >
            {(actor) => (
              <>
                <Title>
                  {t`${actor().rawName ?? actor().username}'s notes`}
                </Title>
                <Meta
                  property="og:title"
                  content={t`${actor().rawName ?? actor().username}'s notes`}
                />
                <NavigateIfHandleIsNotCanonical $actor={actor()} />
                <ProfilePageBreadcrumb $actor={actor()}>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink current>
                      {t`Notes`}
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                </ProfilePageBreadcrumb>
                <div>
                  <ProfileCard $actor={actor()} />
                </div>
                <div class="p-4">
                  <ProfileTabs selected="notes" $actor={actor()} />
                  <ActorNoteList $notes={actor()} />
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
