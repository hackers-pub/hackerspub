import { Navigate, revalidate, useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
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
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { newsAdminPageQuery } from "./__generated__/newsAdminPageQuery.graphql.ts";
import type { newsAdminRecomputeMutation } from "./__generated__/newsAdminRecomputeMutation.graphql.ts";

const newsAdminPageQuery = graphql`
  query newsAdminPageQuery {
    viewer {
      moderator
    }
    newsScoreStatus {
      scoredLinkCount
      lastRecomputedAt
    }
  }
`;

const loadNewsAdminPageQuery = routePreloadedQuery(
  () =>
    loadQuery<newsAdminPageQuery>(
      useRelayEnvironment()(),
      newsAdminPageQuery,
      {},
      { fetchPolicy: "network-only" },
    ),
  "loadNewsAdminPageQuery",
);

const newsAdminRecomputeMutation = graphql`
  mutation newsAdminRecomputeMutation {
    recomputeNewsScores {
      __typename
      ... on RecomputeNewsScoresPayload {
        linksUpdated
        status {
          scoredLinkCount
          lastRecomputedAt
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

export default function AdminNewsPage() {
  const { i18n, t } = useLingui();
  const navigate = useNavigate();
  const data = createStablePreloadedQuery<newsAdminPageQuery>(
    newsAdminPageQuery,
    () => loadNewsAdminPageQuery(),
  );
  const [recompute] = createMutation<newsAdminRecomputeMutation>(
    newsAdminRecomputeMutation,
  );
  const [submitting, setSubmitting] = createSignal(false);

  function onRecompute() {
    setSubmitting(true);
    recompute({
      variables: {},
      onCompleted(response) {
        setSubmitting(false);
        const result = response.recomputeNewsScores;
        if (result.__typename === "RecomputeNewsScoresPayload") {
          showToast({
            title: i18n._(
              msg`${
                plural(result.linksUpdated!, {
                  one: "Recomputed # link.",
                  other: "Recomputed # links.",
                })
              }`,
            ),
          });
          void revalidate("loadNewsAdminPageQuery");
        } else if (result.__typename === "NotAuthenticatedError") {
          navigate("/sign?next=%2Fadmin%2Fnews", { replace: true });
        } else {
          showToast({
            title: t`Not authorized to recompute news scores.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        setSubmitting(false);
        console.error(error);
        showToast({
          title: t`Failed to recompute news scores.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  return (
    <NarrowContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · News scores`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            keyed
            when={data.viewer?.moderator}
            fallback={data.viewer == null
              ? <Navigate href="/sign?next=%2Fadmin%2Fnews" />
              : <Navigate href="/" />}
          >
            {(_) => {
              const status = () => data.newsScoreStatus;
              return (
                <>
                  <h1 class="mb-4 text-2xl font-semibold tracking-tight">
                    {t`News scores`}
                  </h1>
                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Recompute news scores`}</CardTitle>
                      <CardDescription>
                        {t`Rebuilds the popularity score of every shared link from scratch. The operation is idempotent and safe to run at any time; scores normally stay fresh on their own, so this is mainly a manual backstop and a development tool.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="space-y-2 text-sm">
                      <p>
                        {i18n._(
                          msg`${
                            plural(status()?.scoredLinkCount ?? 0, {
                              one: "# link is currently in the news feed.",
                              other: "# links are currently in the news feed.",
                            })
                          }`,
                        )}
                      </p>
                      <p>
                        <span class="text-muted-foreground">
                          {t`Last recomputed:`}
                        </span>{" "}
                        <Show
                          keyed
                          when={status()?.lastRecomputedAt}
                          fallback={t`never`}
                        >
                          {(ts) => <Timestamp value={ts} />}
                        </Show>
                      </p>
                    </CardContent>
                    <CardFooter>
                      <Button on:click={onRecompute} disabled={submitting()}>
                        {submitting()
                          ? t`Recomputing…`
                          : t`Recompute news scores`}
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
