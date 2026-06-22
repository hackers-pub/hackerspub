import { Navigate, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import type { RequestIdOrganizationConversionRedirectQuery } from "./__generated__/RequestIdOrganizationConversionRedirectQuery.graphql.ts";

const requestIdOrganizationConversionRedirectQuery = graphql`
  query RequestIdOrganizationConversionRedirectQuery($requestId: UUID!) {
    viewer {
      id
    }
    organizationConversionRequest(id: $requestId) {
      account {
        username
      }
    }
  }
`;

const loadRedirectQuery = routePreloadedQuery(
  (requestId: OrganizationConversionRequestId) =>
    loadQuery<RequestIdOrganizationConversionRedirectQuery>(
      useRelayEnvironment()(),
      requestIdOrganizationConversionRedirectQuery,
      { requestId },
      { fetchPolicy: "network-only" },
    ),
  "loadOrganizationConversionRedirectQuery",
);

type OrganizationConversionRequestId =
  RequestIdOrganizationConversionRedirectQuery["variables"]["requestId"];

export default function OrganizationConversionRequestRedirect() {
  const params = useParams();
  const requestId = createMemo(() => decodeRouteParam(params.requestId!));
  const data = createStablePreloadedQuery<
    RequestIdOrganizationConversionRedirectQuery
  >(
    requestIdOrganizationConversionRedirectQuery,
    () => loadRedirectQuery(requestId() as OrganizationConversionRequestId),
  );
  const signInHref = createMemo(() =>
    `/sign?next=${
      encodeURIComponent(`/organization-conversions/${requestId()}`)
    }`
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <Show
          keyed
          when={data.viewer}
          fallback={<Navigate href={signInHref()} />}
        >
          <Show
            keyed
            when={data.organizationConversionRequest}
            fallback={<NotFoundPage embedded />}
          >
            {(request) => (
              <Navigate
                href={`/@${request.account.username}/org-conversions/${requestId()}`}
              />
            )}
          </Show>
        </Show>
      )}
    </Show>
  );
}
