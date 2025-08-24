import {
  query,
  RouteDefinition,
  type RouteSectionProps,
  useParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { NavigateIfHandleIsNotCanonical } from "~/components/NavigateIfHandleIsNotCanonical.tsx";
import { ProfileCard } from "~/components/ProfileCard.tsx";
import {
  ProfilePageBreadcrumb,
  ProfilePageBreadcrumbProvider,
} from "~/components/ProfilePageBreadcrumb.tsx";
import type { ProfileLayoutQuery } from "./__generated__/ProfileLayoutQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    void loadProfileLayoutQuery(args.params.handle);
  },
} satisfies RouteDefinition;

const ProfileLayoutQuery = graphql`
  query ProfileLayoutQuery($handle: String!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      ...NavigateIfHandleIsNotCanonical_actor
      ...ProfilePageBreadcrumb_actor
      ...ProfileCard_actor
    }
  }
`;

const loadProfileLayoutQuery = query(
  (handle: string) =>
    loadQuery<ProfileLayoutQuery>(
      useRelayEnvironment()(),
      ProfileLayoutQuery,
      { handle },
    ),
  "loadProfileLayoutQuery",
);

export default function ProfileLayout(props: RouteSectionProps) {
  const params = useParams();
  const data = createPreloadedQuery<ProfileLayoutQuery>(
    ProfileLayoutQuery,
    () => loadProfileLayoutQuery(params.handle),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show when={data().actorByHandle}>
            {(actor) => (
              <>
                <NavigateIfHandleIsNotCanonical $actor={actor()} />
                <ProfilePageBreadcrumbProvider>
                  <ProfilePageBreadcrumb $actor={actor()} />
                  <div>
                    <ProfileCard $actor={actor()} />
                  </div>
                  <div class="p-4">
                    {props.children}
                  </div>
                </ProfilePageBreadcrumbProvider>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
