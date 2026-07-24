import { Navigate, revalidate, useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.ts";
import type { invitationsPageQuery } from "./__generated__/invitationsPageQuery.graphql.ts";
import type { invitationsRegenerateMutation } from "./__generated__/invitationsRegenerateMutation.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

const invitationsPageQuery = graphql`
  query invitationsPageQuery {
    viewer {
      moderator
    }
    invitationRegenerationStatus {
      lastRegenerated
      cutoffDate
      eligibleAccountsCount
      topThirdCount
    }
  }
`;

const loadAdminInvitationsPageQuery = routePreloadedQuery(
  () =>
    loadQuery<invitationsPageQuery>(
      useRelayEnvironment()(),
      invitationsPageQuery,
      {},
      { fetchPolicy: "network-only" },
    ),
  "loadAdminInvitationsPageQuery",
);

const invitationsRegenerateMutation = graphql`
  mutation invitationsRegenerateMutation {
    regenerateInvitations {
      __typename
      ... on RegenerateInvitationsPayload {
        accountsAffected
        regenerated
        status {
          lastRegenerated
          cutoffDate
          eligibleAccountsCount
          topThirdCount
        }
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

export default function AdminInvitationsPage() {
  const { i18n, t } = useLingui();
  const navigate = useNavigate();
  const data = createStablePreloadedQuery<invitationsPageQuery>(
    invitationsPageQuery,
    () => loadAdminInvitationsPageQuery(),
  );
  const [regenerate] = createMutation<invitationsRegenerateMutation>(
    invitationsRegenerateMutation,
  );
  const [submitting, setSubmitting] = createSignal(false);

  function onRegenerate() {
    setSubmitting(true);
    regenerate({
      variables: {},
      onCompleted(response) {
        setSubmitting(false);
        const result = response.regenerateInvitations;
        if (result.__typename === "RegenerateInvitationsPayload") {
          showToast({
            title: i18n._(
              msg`${plural(result.accountsAffected!, {
                one: "Regenerated invitations for # account.",
                other: "Regenerated invitations for # accounts.",
              })}`,
            ),
          });
          // Relay does not normalise the mutation's nested `status`
          // back into the root `Query.invitationRegenerationStatus`
          // field, so refetch the page query to pick up the new
          // last-regenerated timestamp and recomputed cutoff.
          void revalidate("loadAdminInvitationsPageQuery");
        } else if (result.__typename === "NotAuthenticatedError") {
          // Session expired while the page was open; send the user
          // back through sign-in instead of a misleading toast.
          navigate("/sign?next=%2Fadmin%2Finvitations", { replace: true });
        } else {
          showToast({
            title: t`Not authorized to regenerate invitations.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        setSubmitting(false);
        console.error(error);
        showToast({
          title: t`Failed to regenerate invitations.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  return (
    <NarrowContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Invitations`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            keyed
            when={data.viewer?.moderator}
            fallback={<Navigate href="/sign?next=%2Fadmin%2Finvitations" />}
          >
            {(_) => {
              const status = () => data.invitationRegenerationStatus;
              return (
                <>
                  <AdminTabs selected="invitations" />
                  <h1 class="mb-4 mt-4 text-2xl font-semibold tracking-tight">
                    {t`Invitations`}
                  </h1>
                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Regenerate invitations`}</CardTitle>
                      <CardDescription>
                        {t`Grants one extra invitation to the most active accounts (the top third by post count) since the last regeneration cutoff.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="space-y-2 text-sm">
                      <p>
                        <span class="text-muted-foreground">
                          {t`Last regenerated:`}
                        </span>{" "}
                        <Show
                          keyed
                          when={status()?.lastRegenerated}
                          fallback={
                            <span class="text-muted-foreground/70">
                              {t`Never`}
                            </span>
                          }
                        >
                          {(ts) => <Timestamp value={ts} />}
                        </Show>
                      </p>
                      <p>
                        <span class="text-muted-foreground">{t`Cutoff:`}</span>{" "}
                        <Show keyed when={status()?.cutoffDate}>
                          {(ts) => <Timestamp value={ts} />}
                        </Show>
                      </p>
                      <p>
                        {i18n._(
                          msg`${plural(status()?.eligibleAccountsCount ?? 0, {
                            one: "# eligible account",
                            other: "# eligible accounts",
                          })}; ${plural(status()?.topThirdCount ?? 0, {
                            one: "# would receive an invitation",
                            other: "# would receive invitations",
                          })} if regenerated now.`,
                        )}
                      </p>
                    </CardContent>
                    <CardFooter>
                      <Button on:click={onRegenerate} disabled={submitting()}>
                        {submitting() ? t`Regenerating…` : t`Regenerate`}
                      </Button>
                    </CardFooter>
                  </Card>
                </>
              );
            }}
          </Show>
        )}
      </Show>
    </NarrowContainer>
  );
}
