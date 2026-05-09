import { Navigate, type RouteDefinition, useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { PersonalTimeline } from "~/components/PersonalTimeline.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { buildSignInHref, gateOnAuthentication } from "~/lib/authGate.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";
import type { feedTimelineQuery } from "./__generated__/feedTimelineQuery.graphql.ts";

export const route = {
  preload({ location }) {
    const env = useRelayEnvironment()();
    const action = gateOnAuthentication(
      env,
      location.pathname + location.search + location.hash,
    );
    if (action === "skip") return;
    const { i18n } = useLingui();
    void loadFeedTimelineQuery(i18n.locale);
  },
} satisfies RouteDefinition;

const feedTimelineQuery = graphql`
  query feedTimelineQuery($locale: Locale) {
    ...PersonalTimeline_posts @arguments(locale: $locale)
  }
`;

const loadFeedTimelineQuery = routePreloadedQuery(
  (locale: string) =>
    loadQuery<feedTimelineQuery>(
      useRelayEnvironment()(),
      feedTimelineQuery,
      { locale },
    ),
  "loadFeedTimelineQuery",
);

// Mounted only after the viewer is known to be authenticated. Keeping
// `createPreloadedQuery` inside this child means the protected feed
// query is never even read for anonymous visitors — preventing the
// render path from triggering it before <Navigate> takes over.
function AuthenticatedFeedTimeline() {
  const { i18n } = useLingui();
  const data = createPreloadedQuery<feedTimelineQuery>(
    feedTimelineQuery,
    () => loadFeedTimelineQuery(i18n.locale),
  );
  return (
    <Show keyed when={data()}>
      {(data) => (
        <NarrowContainer>
          <PersonalTimeline $posts={data} />
        </NarrowContainer>
      )}
    </Show>
  );
}

export default function FeedTimeline() {
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
        <AuthenticatedFeedTimeline />
      </Show>
    </Show>
  );
}
