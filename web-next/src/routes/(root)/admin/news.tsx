import { A, Navigate, revalidate, useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, For, Show } from "solid-js";
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
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { newsAdminPageQuery } from "./__generated__/newsAdminPageQuery.graphql.ts";
import type { newsAdminRecomputeMutation } from "./__generated__/newsAdminRecomputeMutation.graphql.ts";
import type { newsAdminAddPatternMutation } from "./__generated__/newsAdminAddPatternMutation.graphql.ts";
import type { newsAdminRemovePatternMutation } from "./__generated__/newsAdminRemovePatternMutation.graphql.ts";
import type { newsAdminClearPenaltyMutation } from "./__generated__/newsAdminClearPenaltyMutation.graphql.ts";

const newsAdminPageQuery = graphql`
  query newsAdminPageQuery {
    viewer {
      moderator
    }
    newsScoreStatus {
      scoredLinkCount
      lastRecomputedAt
    }
    newsExcludedPatterns {
      id
      pattern
      note
      created
    }
    newsPenalizedStories {
      uuid
      url
      title
      penalty
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

const newsAdminAddPatternMutation = graphql`
  mutation newsAdminAddPatternMutation($pattern: String!, $note: String) {
    addNewsExcludedPattern(pattern: $pattern, note: $note) {
      __typename
      ... on NewsExcludedPattern {
        id
      }
      ... on InvalidInputError {
        inputPath
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

const newsAdminRemovePatternMutation = graphql`
  mutation newsAdminRemovePatternMutation($id: UUID!) {
    removeNewsExcludedPattern(id: $id) {
      __typename
      ... on RemoveNewsExcludedPatternPayload {
        removedId
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

const newsAdminClearPenaltyMutation = graphql`
  mutation newsAdminClearPenaltyMutation($id: UUID!) {
    setNewsScorePenalty(id: $id, penalty: NONE) {
      __typename
      ... on PostLink {
        uuid
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

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

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
  const [addPattern] = createMutation<newsAdminAddPatternMutation>(
    newsAdminAddPatternMutation,
  );
  const [removePattern] = createMutation<newsAdminRemovePatternMutation>(
    newsAdminRemovePatternMutation,
  );
  const [clearPenalty] = createMutation<newsAdminClearPenaltyMutation>(
    newsAdminClearPenaltyMutation,
  );
  const [submitting, setSubmitting] = createSignal(false);
  const [patternInput, setPatternInput] = createSignal("");
  const [noteInput, setNoteInput] = createSignal("");
  const [adding, setAdding] = createSignal(false);

  const refresh = () => void revalidate("loadNewsAdminPageQuery");
  const onNotAuthenticated = () =>
    navigate("/sign?next=%2Fadmin%2Fnews", { replace: true });

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
          refresh();
        } else if (result.__typename === "NotAuthenticatedError") {
          onNotAuthenticated();
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

  function onAddPattern(event: Event) {
    event.preventDefault();
    const pattern = patternInput().trim();
    if (pattern.length < 1) return;
    setAdding(true);
    addPattern({
      variables: { pattern, note: noteInput().trim() || null },
      onCompleted(response) {
        setAdding(false);
        const result = response.addNewsExcludedPattern;
        if (result.__typename === "NewsExcludedPattern") {
          setPatternInput("");
          setNoteInput("");
          showToast({ title: t`Exclusion pattern added.` });
          refresh();
        } else if (result.__typename === "InvalidInputError") {
          showToast({
            title: t`That is not a valid URL pattern.`,
            variant: "error",
          });
        } else if (result.__typename === "NotAuthenticatedError") {
          onNotAuthenticated();
        } else {
          showToast({
            title: t`Not authorized to manage exclusions.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        setAdding(false);
        showToast({
          title: t`Failed to add exclusion pattern.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  function onRemovePattern(
    id: `${string}-${string}-${string}-${string}-${string}`,
  ) {
    removePattern({
      variables: { id },
      onCompleted(response) {
        const result = response.removeNewsExcludedPattern;
        if (result?.__typename === "RemoveNewsExcludedPatternPayload") {
          showToast({ title: t`Exclusion pattern removed.` });
          refresh();
        } else if (result?.__typename === "NotAuthenticatedError") {
          onNotAuthenticated();
        } else {
          showToast({
            title: t`Not authorized to manage exclusions.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Failed to remove exclusion pattern.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  function onClearPenalty(
    uuid: `${string}-${string}-${string}-${string}-${string}`,
  ) {
    clearPenalty({
      variables: { id: uuid },
      onCompleted(response) {
        const result = response.setNewsScorePenalty;
        if (result?.__typename === "PostLink") {
          showToast({ title: t`Penalty cleared.` });
          refresh();
        } else if (result?.__typename === "NotAuthenticatedError") {
          onNotAuthenticated();
        } else {
          showToast({
            title: t`Not authorized to clear penalties.`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Failed to clear penalty.`,
          description: import.meta.env.DEV ? error.message : undefined,
          variant: "error",
        });
      },
    });
  }

  return (
    <NarrowContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · News`}</Title>
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
              const patterns = () => data.newsExcludedPatterns ?? [];
              const penalized = () => data.newsPenalizedStories ?? [];
              return (
                <div class="space-y-6">
                  <h1 class="text-2xl font-semibold tracking-tight">
                    {t`News`}
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

                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Excluded URL patterns`}</CardTitle>
                      <CardDescription>
                        {t`Hide links matching a URL pattern from the news feed list (every sort order). Their discussion pages stay reachable by direct link. Patterns use the URLPattern syntax, e.g. https://example.com/* or https://*.example.com/*.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent class="space-y-4">
                      <form
                        class="flex flex-col gap-3 sm:flex-row sm:items-end"
                        on:submit={onAddPattern}
                      >
                        <TextField class="grid flex-1 gap-1.5">
                          <TextFieldLabel for="news-pattern">
                            {t`URL pattern`}
                          </TextFieldLabel>
                          <TextFieldInput
                            id="news-pattern"
                            type="text"
                            placeholder="https://example.com/*"
                            value={patternInput()}
                            onInput={(e) =>
                              setPatternInput(e.currentTarget.value)}
                          />
                        </TextField>
                        <TextField class="grid flex-1 gap-1.5">
                          <TextFieldLabel for="news-note">
                            {t`Note (optional)`}
                          </TextFieldLabel>
                          <TextFieldInput
                            id="news-note"
                            type="text"
                            value={noteInput()}
                            onInput={(e) => setNoteInput(e.currentTarget.value)}
                          />
                        </TextField>
                        <Button
                          type="submit"
                          disabled={adding() ||
                            patternInput().trim().length < 1}
                        >
                          {adding() ? t`Adding…` : t`Add`}
                        </Button>
                      </form>
                      <Show
                        when={patterns().length > 0}
                        fallback={
                          <p class="text-sm text-muted-foreground">
                            {t`No exclusion patterns yet.`}
                          </p>
                        }
                      >
                        <ul class="divide-y rounded-md border">
                          <For each={patterns()}>
                            {(p) => (
                              <li class="flex items-center gap-3 px-3 py-2">
                                <div class="min-w-0 flex-1">
                                  <p class="truncate font-mono text-sm">
                                    {p.pattern}
                                  </p>
                                  <Show when={p.note}>
                                    <p class="truncate text-xs text-muted-foreground">
                                      {p.note}
                                    </p>
                                  </Show>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  on:click={() => onRemovePattern(p.id)}
                                >
                                  {t`Remove`}
                                </Button>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>{t`Penalized links`}</CardTitle>
                      <CardDescription>
                        {t`Links a moderator has demoted in the popular feed. Clear a penalty to restore a link's normal ranking.`}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Show
                        when={penalized().length > 0}
                        fallback={
                          <p class="text-sm text-muted-foreground">
                            {t`No penalized links.`}
                          </p>
                        }
                      >
                        <ul class="divide-y rounded-md border">
                          <For each={penalized()}>
                            {(link) => (
                              <li class="flex items-center gap-3 px-3 py-2">
                                <div class="min-w-0 flex-1">
                                  <A
                                    href={`/news/${link.uuid}`}
                                    class="block truncate text-sm font-medium hover:underline"
                                  >
                                    {link.title || host(link.url)}
                                  </A>
                                  <p class="truncate text-xs text-muted-foreground">
                                    {host(link.url)}
                                    {" · "}
                                    {link.penalty === "BURY"
                                      ? t`Buried`
                                      : t`Demoted`}
                                  </p>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  on:click={() => onClearPenalty(link.uuid)}
                                >
                                  {t`Clear`}
                                </Button>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </CardContent>
                  </Card>
                </div>
              );
            }}
          </Show>
        )}
      </Show>
    </NarrowContainer>
  );
}
