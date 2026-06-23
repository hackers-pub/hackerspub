import { Meta } from "@solidjs/meta";
import { type RouteDefinition, useParams } from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { ActorNoteList } from "~/components/ActorNoteList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NavigateIfHandleIsNotCanonical } from "~/components/NavigateIfHandleIsNotCanonical.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  PROFILE_NOTES_QUERY_KEY,
  profileContentRevalidating,
} from "~/lib/profileContentQueries.ts";
import type { notesPageQuery } from "./__generated__/notesPageQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

const notesPageQuery = graphql`
  query notesPageQuery($handle: String!, $actingAccountId: ID) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      rawName
      username
      viewerBlocks(actingAccountId: $actingAccountId)
      blocksViewer(actingAccountId: $actingAccountId)
      ...NavigateIfHandleIsNotCanonical_actor
      ...ActorNoteList_notes
      ...ProfileCard_actor @arguments(actingAccountId: $actingAccountId)
      ...ProfileTabs_actor @arguments(actingAccountId: $actingAccountId)
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (handle: string, actingAccountId: string | null) =>
    loadQuery<notesPageQuery>(
      useRelayEnvironment()(),
      notesPageQuery,
      { handle, actingAccountId },
      { fetchPolicy: "store-and-network" },
    ),
  PROFILE_NOTES_QUERY_KEY,
);

export default function ProfileNotesPage() {
  const params = useParams();
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<notesPageQuery>(
    notesPageQuery,
    () =>
      loadPageQuery(
        decodeRouteParam(params.handle!),
        actingAccountId() ?? null,
      ),
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
          <Show
            keyed
            when={data.actorByHandle}
            fallback={<NotFoundPage fullscreen />}
          >
            {(actor) => (
              <NarrowContainer>
                <Title>
                  {t`${actor.rawName ?? actor.username}'s notes`}
                </Title>
                <Meta
                  property="og:title"
                  content={t`${actor.rawName ?? actor.username}'s notes`}
                />
                <NavigateIfHandleIsNotCanonical $actor={actor} />
                <div>
                  <ProfileCard $actor={actor} />
                </div>
                <Show
                  when={!actor.viewerBlocks && !actor.blocksViewer &&
                    !profileContentRevalidating()}
                >
                  <div class="p-4">
                    <ProfileTabs selected="notes" $actor={actor} />
                    <ActorNoteList $notes={actor} />
                  </div>
                </Show>
              </NarrowContainer>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
