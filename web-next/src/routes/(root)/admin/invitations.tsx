import { Navigate, revalidate, useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, For, Show } from "solid-js";
import {
  createMutation,
  createPaginationFragment,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
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
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.ts";
import type { invitationsPageQuery } from "~/__generated__/invitationsPageQuery.graphql.ts";
import type { invitationsRegenerateMutation } from "~/__generated__/invitationsRegenerateMutation.graphql.ts";
import type { invitationsSetAutoDistributionMutation } from "~/__generated__/invitationsSetAutoDistributionMutation.graphql.ts";
import type { invitationsDistributionHistory_query$key } from "~/__generated__/invitationsDistributionHistory_query.graphql.ts";
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
      autoDistributionEnabled
    }
    ...invitationsDistributionHistory_query
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
        skipped
        skipReason
        status {
          lastRegenerated
          cutoffDate
          eligibleAccountsCount
          topThirdCount
          autoDistributionEnabled
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

const invitationsSetAutoDistributionMutation = graphql`
  mutation invitationsSetAutoDistributionMutation($enabled: Boolean!) {
    setInvitationAutoDistributionEnabled(enabled: $enabled) {
      __typename
      ... on InvitationRegenerationStatus {
        autoDistributionEnabled
        lastRegenerated
        cutoffDate
        eligibleAccountsCount
        topThirdCount
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

function InvitationDistributionHistory(props: {
  $query: invitationsDistributionHistory_query$key;
}) {
  const { t } = useLingui();
  const data = createPaginationFragment(
    graphql`
      fragment invitationsDistributionHistory_query on Query
      @refetchable(queryName: "invitationsDistributionHistoryPaginationQuery")
      @argumentDefinitions(
        cursor: { type: "String" }
        count: { type: "Int", defaultValue: 20 }
      ) {
        invitationDistributions(first: $count, after: $cursor)
          @connection(key: "invitationsDistributionHistory_invitationDistributions") {
          edges {
            cursor
            node {
              uuid
              kind
              created
              amount
              accountsAffected
              cutoffDate
              periodEnd
              actorUsername
              targetUsername
              note
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$query,
  );
  const [loading, setLoading] = createSignal<"loaded" | "loading" | "errored">(
    "loaded",
  );

  function onLoadMore() {
    setLoading("loading");
    data.loadNext(20, {
      onComplete(error) {
        setLoading(error == null ? "loaded" : "errored");
      },
    });
  }

  function kindLabel(kind: string) {
    switch (kind) {
      case "SCHEDULED":
        return t`Automatic`;
      case "MANUAL":
        return t`Manual`;
      case "GRANT":
        return t`Direct grant`;
      default:
        return kind;
    }
  }

  return (
    <Show keyed when={data()?.invitationDistributions}>
      {(connection) => (
        <>
          <div class="rounded-lg border bg-card shadow-sm">
            <Table class="min-w-[44rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>{t`When`}</TableHead>
                  <TableHead>{t`Type`}</TableHead>
                  <TableHead class="text-right">{t`Recipients`}</TableHead>
                  <TableHead class="text-right">{t`Invitations`}</TableHead>
                  <TableHead>{t`Cutoff`}</TableHead>
                  <TableHead>{t`Actor / target`}</TableHead>
                  <TableHead>{t`Grant note`}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <For each={connection.edges}>
                  {(edge) => (
                    <TableRow>
                      <TableCell>
                        <Timestamp
                          value={edge.node.created}
                          relativeStyle="narrow"
                        />
                      </TableCell>
                      <TableCell>{kindLabel(edge.node.kind)}</TableCell>
                      <TableCell class="text-right">
                        {edge.node.accountsAffected}
                      </TableCell>
                      <TableCell class="text-right">
                        {edge.node.amount}
                      </TableCell>
                      <TableCell>
                        <Show
                          keyed
                          when={edge.node.cutoffDate}
                          fallback={
                            <span class="text-muted-foreground">—</span>
                          }
                        >
                          {(cutoff) => (
                            <Timestamp value={cutoff} relativeStyle="narrow" />
                          )}
                        </Show>
                      </TableCell>
                      <TableCell>
                        <Show
                          keyed
                          when={
                            edge.node.targetUsername ?? edge.node.actorUsername
                          }
                          fallback={
                            <span class="text-muted-foreground">System</span>
                          }
                        >
                          {(username) => (
                            <span>
                              {edge.node.kind === "GRANT" &&
                              edge.node.actorUsername != null
                                ? `@${edge.node.actorUsername} → @${username}`
                                : `@${username}`}
                            </span>
                          )}
                        </Show>
                      </TableCell>
                      <TableCell
                        class="max-w-48 truncate"
                        title={edge.node.note ?? ""}
                      >
                        {edge.node.note ?? ""}
                      </TableCell>
                    </TableRow>
                  )}
                </For>
              </TableBody>
            </Table>
            <Show when={connection.edges.length === 0}>
              <p class="p-4 text-sm text-muted-foreground">
                {t`No invitation distributions recorded yet.`}
              </p>
            </Show>
            <Show when={data.hasNext}>
              <div class="border-t p-4 text-center">
                <Button
                  variant="outline"
                  on:click={onLoadMore}
                  disabled={data.pending || loading() === "loading"}
                >
                  <Show
                    when={loading() !== "errored"}
                    fallback={t`Failed to load more; click to retry`}
                  >
                    {loading() === "loading" || data.pending
                      ? t`Loading more…`
                      : t`Load more`}
                  </Show>
                </Button>
              </div>
            </Show>
          </div>
        </>
      )}
    </Show>
  );
}

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
  const [setAutoDistribution, settingAutoDistribution] =
    createMutation<invitationsSetAutoDistributionMutation>(
      invitationsSetAutoDistributionMutation,
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
          if (result.skipped) {
            showToast({
              title:
                result.skipReason === "duplicate"
                  ? t`This regeneration was already recorded; the balance did not change.`
                  : t`A later run already advanced the cutoff, so this regeneration changed nothing.`,
            });
          } else {
            showToast({
              title: i18n._(
                msg`${plural(result.accountsAffected!, {
                  one: "Regenerated invitations for # account.",
                  other: "Regenerated invitations for # accounts.",
                })}`,
              ),
            });
          }
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

  function onToggleAutoDistribution(enabled: boolean) {
    setAutoDistribution({
      variables: { enabled },
      onCompleted(response) {
        const result = response.setInvitationAutoDistributionEnabled;
        if (result.__typename === "InvitationRegenerationStatus") {
          showToast({
            title: enabled
              ? t`Automatic invitation distribution enabled.`
              : t`Automatic invitation distribution paused.`,
          });
          void revalidate("loadAdminInvitationsPageQuery");
        } else if (result.__typename === "NotAuthenticatedError") {
          navigate("/sign?next=%2Fadmin%2Finvitations", { replace: true });
        } else {
          showToast({
            title: t`Not authorized to change automatic distribution.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        console.error(error);
        showToast({
          title: t`Failed to change automatic distribution.`,
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
                      <CardTitle>{t`Automatic distribution`}</CardTitle>
                      <CardDescription>
                        {t`Runs every Monday and Thursday at 00:15 UTC. It grants one invitation to the top third of accounts active since the last run.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Checkbox
                        checked={status()?.autoDistributionEnabled ?? false}
                        disabled={settingAutoDistribution()}
                        onChange={onToggleAutoDistribution}
                      >
                        <CheckboxLabel>
                          {t`Automatically distribute invitations`}
                        </CheckboxLabel>
                      </Checkbox>
                    </CardContent>
                  </Card>
                  <Card class="mt-4">
                    <CardHeader>
                      <CardTitle>{t`Regenerate invitations`}</CardTitle>
                      <CardDescription>
                        {t`Grants one extra invitation to the most active accounts (the top third by post count) since the last regeneration cutoff.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="space-y-2 text-sm">
                      <p>
                        <span class="text-muted-foreground">
                          {t`Current cutoff:`}
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
                  <Card class="mt-4">
                    <CardHeader>
                      <CardTitle>{t`Distribution history`}</CardTitle>
                      <CardDescription>
                        {t`Committed automatic runs, manual regenerations, and direct grants.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <InvitationDistributionHistory $query={data} />
                    </CardContent>
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
