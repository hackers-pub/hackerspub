import { Navigate, useLocation, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NavigateIfHandleIsNotCanonical_actor$key } from "./__generated__/NavigateIfHandleIsNotCanonical_actor.graphql.ts";

export interface NavigateIfHandleIsNotCanonicalProps {
  $actor: NavigateIfHandleIsNotCanonical_actor$key;
}

export function NavigateIfHandleIsNotCanonical(
  props: NavigateIfHandleIsNotCanonicalProps,
) {
  const params = useParams<{ handle: string }>();
  const location = useLocation();
  const actor = createFragment(
    graphql`
      fragment NavigateIfHandleIsNotCanonical_actor on Actor {
        local
        username
      }
    `,
    () => props.$actor,
  );

  return (
    <Show when={actor()}>
      {(actor) => (
        <Show
          when={actor().local && params.handle != null &&
            params.handle.indexOf("@", 1) > 0}
          fallback={null}
        >
          <Navigate
            href={location.pathname.replace(
              /^\/@[^/]+/,
              `/@${actor().username}`,
            ) + location.search + location.hash}
          />
        </Show>
      )}
    </Show>
  );
}
