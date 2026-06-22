import { A, Navigate, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, createSignal, Show } from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import IconCheck from "~icons/lucide/check";
import IconExternalLink from "~icons/lucide/external-link";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { Title } from "~/components/Title.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import type { RequestIdAcceptOrganizationConversionMutation } from "./__generated__/RequestIdAcceptOrganizationConversionMutation.graphql.ts";
import type { RequestIdOrganizationConversionPageQuery } from "./__generated__/RequestIdOrganizationConversionPageQuery.graphql.ts";

const requestIdOrganizationConversionPageQuery = graphql`
  query RequestIdOrganizationConversionPageQuery($requestId: UUID!) {
    viewer {
      id
    }
    organizationConversionRequest(id: $requestId) {
      uuid
      accepted
      account {
        username
        name
        avatarUrl
      }
      admin {
        username
      }
    }
  }
`;

const requestIdAcceptOrganizationConversionMutation = graphql`
  mutation RequestIdAcceptOrganizationConversionMutation($requestId: UUID!) {
    acceptOrganizationConversion(input: { requestId: $requestId }) {
      __typename
      ... on AcceptOrganizationConversionPayload {
        organization {
          username
        }
      }
      ... on OrganizationConversionError {
        message
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (requestId: OrganizationConversionRequestId) =>
    loadQuery<RequestIdOrganizationConversionPageQuery>(
      useRelayEnvironment()(),
      requestIdOrganizationConversionPageQuery,
      { requestId },
      { fetchPolicy: "network-only" },
    ),
  "loadOrganizationConversionRequestPageQuery",
);

export default function OrganizationConversionRequestPage() {
  const params = useParams();
  const requestId = createMemo(() => decodeRouteParam(params.requestId!));
  const data = createStablePreloadedQuery<
    RequestIdOrganizationConversionPageQuery
  >(
    requestIdOrganizationConversionPageQuery,
    () => loadPageQuery(requestId() as OrganizationConversionRequestId),
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
              <OrganizationConversionRequestCard request={request} />
            )}
          </Show>
        </Show>
      )}
    </Show>
  );
}

type OrganizationConversionRequest = NonNullable<
  RequestIdOrganizationConversionPageQuery["response"][
    "organizationConversionRequest"
  ]
>;

type OrganizationConversionRequestId =
  RequestIdOrganizationConversionPageQuery["variables"]["requestId"];

function OrganizationConversionRequestCard(
  props: { request: OrganizationConversionRequest },
) {
  const { t } = useLingui();
  const [accepting, setAccepting] = createSignal(false);
  const [acceptConversion] = createMutation<
    RequestIdAcceptOrganizationConversionMutation
  >(requestIdAcceptOrganizationConversionMutation);
  const accepted = () => props.request.accepted != null;

  function onAccept() {
    if (accepting() || accepted()) return;
    setAccepting(true);
    acceptConversion({
      variables: { requestId: props.request.uuid },
      onCompleted(response) {
        setAccepting(false);
        const result = response.acceptOrganizationConversion;
        if (result?.__typename === "AcceptOrganizationConversionPayload") {
          showToast({
            title: t`Account converted`,
            description:
              t`You are now an admin of ${result.organization.username}.`,
          });
          location.assign(`/@${result.organization.username}/settings/account`);
          return;
        }
        showToast({
          title: t`Could not accept conversion`,
          description: result != null && "message" in result
            ? result.message
            : t`This conversion request could not be accepted.`,
          variant: "error",
        });
      },
      onError(error) {
        console.error(error);
        setAccepting(false);
        showToast({
          title: t`Could not accept conversion`,
          description: t`This conversion request could not be accepted.` +
            (import.meta.env.DEV ? `\n\n${error.message}` : ""),
          variant: "error",
        });
      },
    });
  }

  return (
    <NarrowContainer>
      <Title>{t`Hackers' Pub: Organization conversion`}</Title>
      <div class="p-4">
        <Card>
          <CardHeader>
            <CardTitle>{t`Accept organization conversion`}</CardTitle>
            <CardDescription>
              {t`${props.request.account.username} asked you to become the first admin of this organization account.`}
            </CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-5">
            <div class="flex items-center gap-3 rounded-md border p-3">
              <Avatar>
                <AvatarImage
                  src={props.request.account.avatarUrl ?? undefined}
                  alt={props.request.account.name ??
                    props.request.account.username}
                />
                <AvatarFallback>
                  {props.request.account.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div class="min-w-0">
                <p class="truncate font-medium">
                  {props.request.account.name ??
                    props.request.account.username}
                </p>
                <p class="truncate text-sm text-muted-foreground">
                  @{props.request.account.username}
                </p>
              </div>
            </div>

            <div class="rounded-md border border-destructive/35 bg-destructive/5 p-4 text-sm">
              <p class="font-medium text-destructive">
                {t`This action is permanent.`}
              </p>
              <p class="mt-2 text-muted-foreground">
                {t`After acceptance, this account becomes an organization account, cannot sign in directly, and cannot be converted back to a personal account.`}
              </p>
            </div>

            <Show
              when={!accepted()}
              fallback={
                <div class="rounded-md border bg-muted/40 p-4 text-sm">
                  <p class="font-medium">{t`Conversion already accepted`}</p>
                  <p class="mt-1 text-muted-foreground">
                    {t`This request has already been accepted.`}
                  </p>
                  <Button
                    as={A}
                    href={`/@${props.request.account.username}/settings/account`}
                    class="mt-3"
                    size="sm"
                    variant="outline"
                    preload={false}
                  >
                    {t`Open organization settings`}
                    <IconExternalLink />
                  </Button>
                </div>
              }
            >
              <div>
                <Button onClick={onAccept} disabled={accepting()}>
                  <IconCheck />
                  {accepting() ? t`Accepting…` : t`Accept conversion`}
                </Button>
              </div>
            </Show>
          </CardContent>
        </Card>
      </div>
    </NarrowContainer>
  );
}
