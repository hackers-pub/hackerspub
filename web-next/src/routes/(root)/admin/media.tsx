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
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import type { mediaDeleteOrphanMediaMutation } from "./__generated__/mediaDeleteOrphanMediaMutation.graphql.ts";
import type { mediaPageQuery } from "./__generated__/mediaPageQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

const mediaPageQuery = graphql`
  query mediaPageQuery {
    viewer {
      moderator
    }
    orphanMediaStatus {
      cutoffDate
      orphanMediaCount
    }
  }
`;

const loadAdminMediaPageQuery = routePreloadedQuery(
  () =>
    loadQuery<mediaPageQuery>(
      useRelayEnvironment()(),
      mediaPageQuery,
      {},
      { fetchPolicy: "network-only" },
    ),
  "loadAdminMediaPageQuery",
);

const mediaDeleteOrphanMediaMutation = graphql`
  mutation mediaDeleteOrphanMediaMutation {
    deleteOrphanMedia {
      __typename
      ... on DeleteOrphanMediaPayload {
        deletedCount
        failedStorageDeletes
        status {
          cutoffDate
          orphanMediaCount
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

export default function AdminMediaPage() {
  const { i18n, t } = useLingui();
  const navigate = useNavigate();
  const data = createStablePreloadedQuery<mediaPageQuery>(
    mediaPageQuery,
    () => loadAdminMediaPageQuery(),
  );
  const [deleteOrphans] = createMutation<mediaDeleteOrphanMediaMutation>(
    mediaDeleteOrphanMediaMutation,
  );
  const [submitting, setSubmitting] = createSignal(false);

  function onDeleteOrphans() {
    setSubmitting(true);
    deleteOrphans({
      variables: {},
      onCompleted(response) {
        setSubmitting(false);
        const result = response.deleteOrphanMedia;
        if (result.__typename === "DeleteOrphanMediaPayload") {
          showToast({
            title: i18n._(
              msg`${
                plural(result.deletedCount!, {
                  one: "Deleted # orphan medium.",
                  other: "Deleted # orphan media.",
                })
              }`,
            ),
            description: result.failedStorageDeletes! > 0
              ? i18n._(
                msg`${
                  plural(result.failedStorageDeletes!, {
                    one: "# disk object could not be deleted.",
                    other: "# disk objects could not be deleted.",
                  })
                }`,
              )
              : undefined,
            variant: result.failedStorageDeletes! > 0 ? "error" : undefined,
          });
          void revalidate("loadAdminMediaPageQuery");
        } else if (result.__typename === "NotAuthenticatedError") {
          navigate("/sign?next=%2Fadmin%2Fmedia", { replace: true });
        } else {
          showToast({
            title: t`Not authorized to delete orphan media.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        setSubmitting(false);
        console.error(error);
        showToast({
          title: t`Failed to delete orphan media.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  return (
    <NarrowContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Media`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            keyed
            when={data.viewer?.moderator}
            fallback={data.viewer == null
              ? <Navigate href="/sign?next=%2Fadmin%2Fmedia" />
              : <Navigate href="/" />}
          >
            {(_) => {
              const status = () => data.orphanMediaStatus;
              const count = () => status()?.orphanMediaCount ?? 0;
              return (
                <>
                  <AdminTabs selected="media" />
                  <h1 class="mb-4 mt-4 text-2xl font-semibold tracking-tight">
                    {t`Media`}
                  </h1>
                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Delete orphan media`}</CardTitle>
                      <CardDescription>
                        {t`Removes stored media that are old enough and no longer attached to an avatar, note, article draft, or article.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="space-y-2 text-sm">
                      <p>
                        <span class="text-muted-foreground">
                          {t`Cutoff:`}
                        </span>{" "}
                        <Show keyed when={status()?.cutoffDate}>
                          {(ts) => <Timestamp value={ts} />}
                        </Show>
                      </p>
                      <p>
                        {i18n._(
                          msg`${
                            plural(count(), {
                              one: "# orphan medium can be deleted.",
                              other: "# orphan media can be deleted.",
                            })
                          }`,
                        )}
                      </p>
                    </CardContent>
                    <CardFooter>
                      <Button
                        on:click={onDeleteOrphans}
                        disabled={submitting() || count() < 1}
                        variant="destructive"
                      >
                        {submitting() ? t`Deleting…` : t`Delete orphan media`}
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
