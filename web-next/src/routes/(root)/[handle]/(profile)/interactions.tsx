import { Meta } from "@solidjs/meta";
import {
  Navigate,
  type RouteDefinition,
  useLocation,
  useParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { ActorInteractionList } from "~/components/ActorInteractionList.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NavigateIfHandleIsNotCanonical } from "~/components/NavigateIfHandleIsNotCanonical.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import { ProfileTabs } from "~/components/ProfileTabs.tsx";
import { Title } from "~/components/Title.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { buildSignInHref, gateOnAuthentication } from "~/lib/authGate.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  PROFILE_INTERACTIONS_QUERY_KEY,
  profileContentRevalidating,
} from "~/lib/profileContentQueries.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import type { interactionsPageQuery } from "./__generated__/interactionsPageQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload() {
    void gateOnAuthentication(useRelayEnvironment()());
  },
} satisfies RouteDefinition;

const interactionsPageQuery = graphql`
  query interactionsPageQuery(
    $handle: String!
    $locale: Locale!
    $actingAccountId: ID
  ) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      rawName
      username
      local
      handle
      isViewer(actingAccountId: $actingAccountId)
      viewerBlocks(actingAccountId: $actingAccountId)
      blocksViewer(actingAccountId: $actingAccountId)
      ...NavigateIfHandleIsNotCanonical_actor
      ...ActorInteractionList_interactions @arguments(
        locale: $locale
        actingAccountId: $actingAccountId
      )
      ...ProfileCard_actor @arguments(actingAccountId: $actingAccountId)
      ...ProfileTabs_actor @arguments(actingAccountId: $actingAccountId)
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (handle: string, locale: string, actingAccountId: string | null) =>
    loadQuery<interactionsPageQuery>(
      useRelayEnvironment()(),
      interactionsPageQuery,
      { handle, locale, actingAccountId },
      { fetchPolicy: "store-and-network" },
    ),
  PROFILE_INTERACTIONS_QUERY_KEY,
);

function profileBaseUrl(actor: {
  readonly local: boolean;
  readonly username: string;
  readonly handle: string;
}): string {
  return actor.local ? `/@${actor.username}` : `/${actor.handle}`;
}

function AuthenticatedProfileInteractionsPage() {
  const params = useParams();
  const { t, i18n } = useLingui();
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<interactionsPageQuery>(
    interactionsPageQuery,
    () =>
      loadPageQuery(
        decodeRouteParam(params.handle!),
        i18n.locale,
        actingAccountId() ?? null,
      ),
  );
  return (
    <Show keyed when={data()}>
      {(data) => (
        <Show
          keyed
          when={data.actorByHandle}
          fallback={<NotFoundPage fullscreen />}
        >
          {(actor) => (
            <Show
              when={!actor.isViewer}
              fallback={<Navigate href={profileBaseUrl(actor)} />}
            >
              <NarrowContainer>
                <Title>
                  {t`${actor.rawName ?? actor.username}'s interactions`}
                </Title>
                <Meta
                  property="og:title"
                  content={t`${actor.rawName ?? actor.username}'s interactions`}
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
                    <ProfileTabs selected="interactions" $actor={actor} />
                    <ActorInteractionList $interactions={actor} />
                  </div>
                </Show>
              </NarrowContainer>
            </Show>
          )}
        </Show>
      )}
    </Show>
  );
}

export default function ProfileInteractionsPage() {
  const viewer = useViewer();
  const location = useLocation();
  const signInHref = () =>
    buildSignInHref(location.pathname + location.search + location.hash);

  return (
    <Show when={viewer.isLoaded()}>
      <Show
        when={viewer.isAuthenticated()}
        fallback={<Navigate href={signInHref()} />}
      >
        <AuthenticatedProfileInteractionsPage />
      </Show>
    </Show>
  );
}
